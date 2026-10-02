//! Delete Merged Branches. The same repository goes through the rules of this crate and, when
//! `REBASED_NEW_GIT` names a git 2.56 or later, through `git branch --delete-merged`.

use rebased_git::Repo;
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn commit(dir: &Path, file: &str, msg: &str) {
    std::fs::write(dir.join(file), msg).unwrap();
    git(dir, &["add", file]);
    git(dir, &["commit", "-q", "-m", msg]);
}

/// A clone with one branch for each rule. Only `topic-done` and `stack-a` are deleted.
fn setup(name: &str) -> PathBuf {
    let base = std::env::temp_dir().join(format!("rebased-lite-cleanup-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    let origin = base.join("origin.git");
    git(&base, &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
    let mine = base.join("mine");
    git(&base, &["clone", "-q", origin.to_str().unwrap(), mine.to_str().unwrap()]);
    git(&mine, &["config", "user.name", "Me"]);
    git(&mine, &["config", "user.email", "me@example.com"]);
    git(&mine, &["checkout", "-q", "-b", "main"]);
    commit(&mine, "a.txt", "Initial");
    git(&mine, &["push", "-q", "-u", "origin", "main"]);
    git(&mine, &["remote", "set-head", "origin", "main"]);

    // Merged: its commit is on origin/main.
    git(&mine, &["checkout", "-q", "-b", "topic-done"]);
    commit(&mine, "done.txt", "Done");
    git(&mine, &["push", "-q", "origin", "topic-done:main"]);
    git(&mine, &["fetch", "-q"]);
    git(&mine, &["branch", "-q", "-u", "origin/main"]);
    // Not merged.
    git(&mine, &["checkout", "-q", "-b", "topic-open", "--track", "origin/main"]);
    commit(&mine, "open.txt", "Open");
    // A push updates its tracked branch.
    git(&mine, &["checkout", "-q", "-b", "own", "origin/main"]);
    git(&mine, &["push", "-q", "-u", "origin", "own"]);
    // A stack: stack-c is not merged, so stack-b stays; stack-b then tracks nothing.
    git(&mine, &["branch", "-q", "--track", "stack-a", "origin/main"]);
    git(&mine, &["branch", "-q", "--track", "stack-b", "stack-a"]);
    git(&mine, &["checkout", "-q", "-b", "stack-c", "--track", "stack-b"]);
    commit(&mine, "c.txt", "Stack C");
    // Opted out.
    git(&mine, &["branch", "-q", "--track", "opt-out", "origin/main"]);
    git(&mine, &["config", "branch.opt-out.deleteMerged", "false"]);
    // Checked out in a worktree.
    git(&mine, &["branch", "-q", "--track", "in-wt", "origin/main"]);
    git(&mine, &["worktree", "add", "-q", base.join("wt").to_str().unwrap(), "in-wt"]);
    // Its tracked branch is gone.
    git(&mine, &["push", "-q", "origin", "origin/main:refs/heads/gone"]);
    git(&mine, &["fetch", "-q"]);
    git(&mine, &["branch", "-q", "--track", "gone-up", "origin/gone"]);
    git(&mine, &["push", "-q", "origin", "--delete", "gone"]);
    git(&mine, &["fetch", "-q", "--prune"]);
    git(&mine, &["checkout", "-q", "main"]);
    mine
}

fn strings(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

fn names(repo: &Repo, up: &[String], native: bool) -> Vec<String> {
    repo.merged_branches_with(up, native).unwrap().branches.into_iter().map(|b| b.name).collect()
}

fn check(native: bool) {
    let mine = setup(if native { "native" } else { "rules" });
    let repo = Repo::open(&mine).unwrap();
    let up = strings(&["origin", "stack-a"]);
    let found = repo.merged_branches_with(&up, native).unwrap();
    let listed: Vec<&str> = found.branches.iter().map(|b| b.name.as_str()).collect();
    assert_eq!(listed, ["stack-a", "topic-done"], "native: {native}");
    assert_eq!(found.branches[1].upstream, "origin/main");
    assert_eq!(found.branches[1].subject, "Done");

    // A glob of the tracked branches. stack-b does not match, so it stays, and stack-a stays with it.
    assert_eq!(names(&repo, &strings(&["origin/*"]), native), ["topic-done"]);

    // The user keeps stack-a.
    let r = repo.delete_merged_with(&up, &strings(&["stack-a"]), &strings(&["topic-done"]), native).unwrap();
    assert!(r.ok && r.message == "Deleted merged branch topic-done", "{}", r.message);
    assert!(git(&mine, &["branch", "--list", "topic-done"]).is_empty());
    assert!(!git(&mine, &["branch", "--list", "stack-a"]).is_empty());
    repo.apply_undo(&r.undo).unwrap();
    assert!(!git(&mine, &["branch", "--list", "topic-done"]).is_empty());
    assert_eq!(git(&mine, &["rev-parse", "--abbrev-ref", "topic-done@{upstream}"]), "origin/main");
    // Undo writes the local config only: the global value of the branch does not come into the repository.
    let local = Command::new("git").arg("-C").arg(&mine).args(["config", "--local", "--get-all", "branch.topic-done.description"]).output().unwrap();
    assert!(local.stdout.is_empty());

    // A list that changed since the user saw it deletes nothing.
    let err = repo.delete_merged_with(&up, &[], &strings(&["topic-done"]), native).unwrap_err();
    assert!(err.0.contains("changed since the list was made"), "{}", err.0);
    assert!(!git(&mine, &["branch", "--list", "topic-done"]).is_empty());

    // A delete that fails still gives Undo steps for what it did.
    let lock = mine.join(".git/refs/heads/topic-done.lock");
    std::fs::write(&lock, "").unwrap();
    let r = repo.delete_merged_with(&up, &[], &strings(&["stack-a", "topic-done"]), native).unwrap();
    assert!(!r.ok, "{}", r.message);
    std::fs::remove_file(&lock).unwrap();
    repo.apply_undo(&r.undo).unwrap();
    assert!(!git(&mine, &["branch", "--list", "topic-done"]).is_empty() && !git(&mine, &["branch", "--list", "stack-a"]).is_empty());
    assert_eq!(git(&mine, &["rev-parse", "--abbrev-ref", "stack-b@{upstream}"]), "stack-a");

    // Both: stack-b loses its tracked branch, and Undo gives it back.
    let r = repo.delete_merged_with(&up, &[], &strings(&["stack-a", "topic-done"]), native).unwrap();
    assert_eq!(r.message, "Deleted 2 merged branches");
    assert!(git(&mine, &["branch", "--list", "stack-a", "topic-done"]).is_empty());
    assert!(no_upstream(&mine, "stack-b"));
    // Nothing is left to delete.
    let again = repo.delete_merged_with(&strings(&["origin"]), &[], &[], native).unwrap();
    assert!(again.ok && again.undo.is_empty() && again.message == "No merged branch to delete");
    repo.apply_undo(&r.undo).unwrap();
    assert_eq!(git(&mine, &["rev-parse", "--abbrev-ref", "stack-b@{upstream}"]), "stack-a");
    assert_eq!(git(&mine, &["rev-parse", "--abbrev-ref", "stack-a@{upstream}"]), "origin/main");

    // The tracked-branch check goes one level, as in git: stack-c keeps stack-b, not stack-a.
    assert_eq!(names(&repo, &strings(&["origin", "stack-a", "stack-b"]), native), ["stack-a", "topic-done"]);

    // A branch with the name of a tag.
    git(&mine, &["branch", "-q", "--track", "v1", "origin/main"]);
    git(&mine, &["tag", "v1", "origin/main"]);
    assert_eq!(names(&repo, &strings(&["origin"]), native), ["topic-done", "v1"]);
    let r = repo.delete_merged_with(&strings(&["origin"]), &strings(&["topic-done"]), &strings(&["v1"]), native).unwrap();
    assert!(r.ok, "{}", r.message);
    assert!(git(&mine, &["branch", "--list", "v1"]).is_empty());
    repo.apply_undo(&r.undo).unwrap();
    assert_eq!(git(&mine, &["config", "branch.v1.merge"]), "refs/heads/main");

    // The push check reads the push refspecs only, as in git 2.56: with `:` a push no longer updates
    // origin/own, so own is merged.
    git(&mine, &["config", "remote.origin.push", ":"]);
    assert!(names(&repo, &strings(&["origin/*"]), native).contains(&"own".to_string()));
    git(&mine, &["config", "remote.origin.push", "HEAD"]);
    assert!(names(&repo, &strings(&["origin/*"]), native).contains(&"own".to_string()));
    git(&mine, &["config", "--unset-all", "remote.origin.push"]);
    git(&mine, &["config", "push.default", "nothing"]);
    assert!(!names(&repo, &strings(&["origin/*"]), native).contains(&"own".to_string()));
}

fn no_upstream(dir: &Path, branch: &str) -> bool {
    let out = Command::new("git").arg("-C").arg(dir).args(["config", "--get-regexp", &format!(r"^branch\.{branch}\.(merge|remote)$")]).output().unwrap();
    out.stdout.is_empty()
}

#[test]
fn delete_merged_branches() {
    // A global value of a branch, which Undo must not copy into the repository.
    let global = std::env::temp_dir().join(format!("rebased-lite-cleanup-global-{}", std::process::id()));
    std::fs::write(&global, "[branch \"topic-done\"]\n\tdescription = global\n").unwrap();
    std::env::set_var("GIT_CONFIG_GLOBAL", &global);
    check(false);
    if let Ok(program) = std::env::var("REBASED_NEW_GIT") {
        assert!(rebased_git::set_git_program(&program).is_ok());
        assert!(rebased_git::git_at_least(rebased_git::cleanup::NATIVE_VERSION), "REBASED_NEW_GIT is older than 2.56");
        check(true);
    }
}

/// Merged into a branch, as `git branch --merged uat`: the branches do not need to track uat.
#[test]
fn delete_branches_merged_into_a_branch() {
    let dir = std::env::temp_dir().join(format!("rebased-lite-cleanup-into-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "-b", "uat"]);
    git(&dir, &["config", "user.name", "Me"]);
    git(&dir, &["config", "user.email", "me@example.com"]);
    commit(&dir, "a.txt", "Initial");
    git(&dir, &["branch", "sit"]);
    git(&dir, &["checkout", "-q", "-b", "fix/a"]);
    commit(&dir, "fa.txt", "Fix a");
    git(&dir, &["checkout", "-q", "-b", "fix/b", "uat"]);
    commit(&dir, "fb.txt", "Fix b");
    git(&dir, &["checkout", "-q", "uat"]);
    git(&dir, &["merge", "-q", "--no-ff", "-m", "Merge fix/a", "fix/a"]);
    git(&dir, &["config", "branch.fix/a.description", "first fix"]);
    let repo = Repo::open(&dir).unwrap();

    let found = repo.merged_into("uat").unwrap();
    let listed: Vec<(&str, bool)> = found.branches.iter().map(|b| (b.name.as_str(), b.suggest_keep)).collect();
    // fix/b is not merged; uat is the target; sit is merged, but its name says that it lives long.
    assert_eq!(listed, [("fix/a", false), ("sit", true)]);

    let r = repo.delete_merged_into("uat", &strings(&["fix/a"])).unwrap();
    assert!(r.ok && r.message == "Deleted merged branch fix/a", "{}", r.message);
    assert!(git(&dir, &["branch", "--list", "fix/a"]).is_empty());
    repo.apply_undo(&r.undo).unwrap();
    assert!(!git(&dir, &["branch", "--list", "fix/a"]).is_empty());
    assert_eq!(git(&dir, &["config", "branch.fix/a.description"]), "first fix");

    // A branch with new work since the list was made stops the delete.
    git(&dir, &["checkout", "-q", "fix/a"]);
    commit(&dir, "fa2.txt", "More on a");
    git(&dir, &["checkout", "-q", "uat"]);
    let err = repo.delete_merged_into("uat", &strings(&["fix/a"])).unwrap_err();
    assert!(err.0.contains("not merged into uat"), "{}", err.0);
    assert!(repo.merged_into("no-such-branch").is_err());
}
