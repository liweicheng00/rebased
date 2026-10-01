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

fn check(native: bool) {
    let mine = setup(if native { "native" } else { "rules" });
    let repo = Repo::open(&mine).unwrap();
    let up = vec!["origin".to_string(), "stack-a".to_string()];
    let found = repo.merged_branches_with(&up, native).unwrap();
    let names: Vec<&str> = found.branches.iter().map(|b| b.name.as_str()).collect();
    assert_eq!(names, ["stack-a", "topic-done"], "native: {native}");
    assert_eq!(found.branches[1].upstream, "origin/main");
    assert_eq!(found.branches[1].subject, "Done");

    // A glob of the tracked branches. stack-b does not match, so it stays, and stack-a stays with it.
    let glob = repo.merged_branches_with(&["origin/*".to_string()], native).unwrap();
    assert_eq!(glob.branches.iter().map(|b| b.name.as_str()).collect::<Vec<_>>(), ["topic-done"]);

    // The user keeps stack-a.
    let r = repo.delete_merged_with(&up, &["stack-a".to_string()], native).unwrap();
    assert!(r.ok && r.message == "Deleted merged branch topic-done", "{}", r.message);
    assert!(git(&mine, &["branch", "--list", "topic-done"]).is_empty());
    assert!(!git(&mine, &["branch", "--list", "stack-a"]).is_empty());
    repo.apply_undo(&r.undo).unwrap();
    assert!(!git(&mine, &["branch", "--list", "topic-done"]).is_empty());
    assert_eq!(git(&mine, &["rev-parse", "--abbrev-ref", "topic-done@{upstream}"]), "origin/main");

    // Both: stack-b loses its tracked branch, and Undo gives it back.
    let r = repo.delete_merged_with(&up, &[], native).unwrap();
    assert_eq!(r.message, "Deleted 2 merged branches");
    assert!(git(&mine, &["branch", "--list", "stack-a", "topic-done"]).is_empty());
    assert!(no_upstream(&mine, "stack-b"));
    // Nothing is left to delete.
    let again = repo.delete_merged_with(&["origin".to_string()], &[], native).unwrap();
    assert!(again.ok && again.undo.is_empty() && again.message == "No merged branch to delete");
    repo.apply_undo(&r.undo).unwrap();
    assert_eq!(git(&mine, &["rev-parse", "--abbrev-ref", "stack-b@{upstream}"]), "stack-a");
    assert_eq!(git(&mine, &["rev-parse", "--abbrev-ref", "stack-a@{upstream}"]), "origin/main");
}

fn no_upstream(dir: &Path, branch: &str) -> bool {
    let out = Command::new("git").arg("-C").arg(dir).args(["config", "--get-regexp", &format!(r"^branch\.{branch}\.(merge|remote)$")]).output().unwrap();
    out.stdout.is_empty()
}

#[test]
fn delete_merged_branches() {
    check(false);
    if let Ok(program) = std::env::var("REBASED_NEW_GIT") {
        assert!(rebased_git::set_git_program(&program).is_ok());
        assert!(rebased_git::git_at_least(rebased_git::cleanup::NATIVE_VERSION), "REBASED_NEW_GIT is older than 2.56");
        check(true);
    }
}
