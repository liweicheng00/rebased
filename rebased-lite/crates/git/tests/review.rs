//! Review Branch: the changes from the merge base, viewed files, notes, and Finish in its three modes.

use rebased_git::review::FinishMode;
use rebased_git::Repo;
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn commit(dir: &Path, file: &str, content: &str, msg: &str) {
    std::fs::write(dir.join(file), content).unwrap();
    git(dir, &["add", file]);
    git(dir, &["commit", "-q", "-m", msg]);
}

/// main: base, then "Main work" (c.txt). feature: from base, "Change a" and "Add b".
fn setup(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("rebased-lite-review-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "-b", "main"]);
    git(&dir, &["config", "user.name", "Me"]);
    git(&dir, &["config", "user.email", "me@example.com"]);
    git(&dir, &["config", "commit.gpgsign", "false"]);
    commit(&dir, "a.txt", "one\ntwo\nthree\n", "Base");
    git(&dir, &["checkout", "-q", "-b", "feature"]);
    commit(&dir, "a.txt", "one\nTWO\nthree\n", "Change a");
    commit(&dir, "b.txt", "new file\n", "Add b");
    git(&dir, &["checkout", "-q", "main"]);
    commit(&dir, "c.txt", "main\n", "Main work");
    dir
}

#[test]
fn review_shows_the_changes_of_the_branch() {
    let dir = setup("detail");
    let repo = Repo::open(&dir).unwrap();
    repo.start_review("feature", "main").unwrap();
    let d = repo.review("feature").unwrap();
    assert_eq!((d.summary.commits, d.summary.behind), (2, 1));
    // From the merge base: the work on main (c.txt) is not a change of the branch.
    let files: Vec<&str> = d.file_list.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(files, ["a.txt", "b.txt"]);
    assert!(d.summary.conflicts.is_empty());
    assert_eq!(d.commit_list[0].subject, "Add b");

    // Viewed: a new version of the file makes it not viewed again.
    repo.set_viewed("feature", &["a.txt".into(), "b.txt".into()], true).unwrap();
    assert_eq!(repo.review("feature").unwrap().summary.viewed, 2);
    git(&dir, &["checkout", "-q", "feature"]);
    commit(&dir, "a.txt", "one\nTWO\nTHREE\n", "Change a again");
    git(&dir, &["checkout", "-q", "main"]);
    let d = repo.review("feature").unwrap();
    assert_eq!(d.summary.viewed, 1);
    assert!(!d.file_list[0].viewed && d.file_list[1].viewed);

    // Notes: a note on a changed file is outdated.
    repo.add_review_comment("feature", "a.txt", 2, "Why upper case?").unwrap();
    repo.add_review_comment("feature", "b.txt", 1, "Good").unwrap();
    let d = repo.review("feature").unwrap();
    assert_eq!(d.summary.comments, 2);
    assert_eq!(d.file_list[0].comments, 1);
    assert!(d.comment_list.iter().all(|c| !c.outdated));
    git(&dir, &["checkout", "-q", "feature"]);
    commit(&dir, "a.txt", "ONE\nTWO\nTHREE\n", "Change a once more");
    git(&dir, &["checkout", "-q", "main"]);
    let d = repo.review("feature").unwrap();
    let a = d.comment_list.iter().find(|c| c.path == "a.txt").unwrap();
    assert!(a.outdated);
    repo.delete_review_comment("feature", &a.id).unwrap();
    assert_eq!(repo.review("feature").unwrap().summary.comments, 1);

    // The list, and a review of a branch that is gone.
    assert_eq!(repo.reviews().unwrap().len(), 1);
    repo.remove_review("feature").unwrap();
    assert!(repo.reviews().unwrap().is_empty());
}

#[test]
fn merge_on_the_base_and_undo() {
    let dir = setup("merge");
    let repo = Repo::open(&dir).unwrap();
    repo.start_review("feature", "main").unwrap();
    let main = git(&dir, &["rev-parse", "main"]);
    // Staged changes of the user stop the merge on the base.
    std::fs::write(dir.join("c.txt"), "staged\n").unwrap();
    git(&dir, &["add", "c.txt"]);
    let err = repo.finish_review("feature", FinishMode::Squash, "Squash", false).unwrap_err();
    assert!(err.0.contains("staged changes"), "{}", err.0);
    git(&dir, &["reset", "-q", "--hard"]);
    let r = repo.finish_review("feature", FinishMode::Merge, "Merge feature", false).unwrap();
    assert!(r.ok, "{}", r.message);
    assert_eq!(git(&dir, &["log", "-1", "--format=%P", "main"]).split(' ').count(), 2);
    assert_eq!(std::fs::read_to_string(dir.join("b.txt")).unwrap(), "new file\n");
    assert!(repo.review("feature").unwrap().summary.merged);
    repo.apply_undo(&r.undo).unwrap();
    assert_eq!(git(&dir, &["rev-parse", "main"]), main);
    assert!(!dir.join("b.txt").exists());
}

#[test]
fn squash_without_the_working_tree_and_undo() {
    let dir = setup("squash");
    let repo = Repo::open(&dir).unwrap();
    git(&dir, &["checkout", "-q", "-b", "other"]);
    repo.start_review("feature", "main").unwrap();
    let (main, feature) = (git(&dir, &["rev-parse", "main"]), git(&dir, &["rev-parse", "feature"]));
    let r = repo.finish_review("feature", FinishMode::Squash, "Feature in one commit", true).unwrap();
    assert!(r.ok, "{}", r.message);
    assert_eq!(git(&dir, &["log", "-1", "--format=%P", "main"]), main);
    assert_eq!(git(&dir, &["log", "-1", "--format=%s", "main"]), "Feature in one commit");
    assert_eq!(git(&dir, &["show", "main:a.txt"]), "one\nTWO\nthree");
    assert_eq!(git(&dir, &["show", "main:c.txt"]), "main");
    assert!(git(&dir, &["branch", "--list", "feature"]).is_empty());
    // The review stays, as merged.
    let s = &repo.reviews().unwrap()[0];
    assert!(s.merged && !s.exists);
    // The working tree of the other branch did not change.
    assert_eq!(git(&dir, &["rev-parse", "--abbrev-ref", "HEAD"]), "other");
    assert!(!dir.join("b.txt").exists());
    repo.apply_undo(&r.undo).unwrap();
    assert_eq!((git(&dir, &["rev-parse", "main"]), git(&dir, &["rev-parse", "feature"])), (main, feature));
}

#[test]
fn rebase_and_fast_forward() {
    let dir = setup("rebase");
    let repo = Repo::open(&dir).unwrap();
    repo.start_review("feature", "main").unwrap();
    let main = git(&dir, &["rev-parse", "main"]);
    let r = repo.finish_review("feature", FinishMode::Rebase, "", false).unwrap();
    assert!(r.ok, "{}", r.message);
    // Linear: main is the rebased feature, on top of the old main.
    assert_eq!(git(&dir, &["rev-parse", "main"]), git(&dir, &["rev-parse", "feature"]));
    assert_eq!(git(&dir, &["log", "--format=%s", "-3", "main"]), "Add b\nChange a\nMain work");
    assert_eq!(std::fs::read_to_string(dir.join("b.txt")).unwrap(), "new file\n");
    repo.apply_undo(&r.undo).unwrap();
    assert_eq!(git(&dir, &["rev-parse", "main"]), main);
    assert_eq!(git(&dir, &["log", "--format=%s", "-1", "feature"]), "Add b");
    assert_eq!(git(&dir, &["merge-base", "main", "feature"]), git(&dir, &["rev-parse", "main~1"]));
}

#[test]
fn conflicts_show_before_the_merge() {
    let dir = setup("conflict");
    let repo = Repo::open(&dir).unwrap();
    commit(&dir, "a.txt", "one\nTwo on main\nthree\n", "Main changes a");
    git(&dir, &["checkout", "-q", "-b", "other"]);
    repo.start_review("feature", "main").unwrap();
    let d = repo.review("feature").unwrap();
    assert_eq!(d.summary.conflicts, ["a.txt"]);
    let err = repo.finish_review("feature", FinishMode::Merge, "Merge", false).unwrap_err();
    assert!(err.0.contains("conflict: a.txt"), "{}", err.0);
    // On the base, the merge stops with the conflict for the merge tool.
    git(&dir, &["checkout", "-q", "main"]);
    let r = repo.finish_review("feature", FinishMode::Merge, "Merge", false).unwrap();
    assert!(!r.ok && r.conflicts == ["a.txt"], "{}", r.message);
    git(&dir, &["merge", "--abort"]);
}

/// feature only on the remote: origin/feature, and origin/main as a base.
fn setup_remote(name: &str) -> PathBuf {
    let dir = setup(name);
    let feature = git(&dir, &["rev-parse", "feature"]);
    let main = git(&dir, &["rev-parse", "main"]);
    git(&dir, &["update-ref", "refs/remotes/origin/feature", &feature]);
    git(&dir, &["update-ref", "refs/remotes/origin/main", &main]);
    git(&dir, &["branch", "-q", "-D", "feature"]);
    dir
}

#[test]
fn review_of_a_remote_branch() {
    let dir = setup_remote("remote");
    let repo = Repo::open(&dir).unwrap();
    assert!(repo.start_review("origin/nothing", "main").is_err());
    repo.start_review("origin/feature", "main").unwrap();
    let d = repo.review("origin/feature").unwrap();
    assert!(d.summary.exists && d.summary.branch_is_remote && !d.summary.base_is_remote);
    assert_eq!((d.summary.commits, d.summary.files), (2, 2));
    repo.set_viewed("origin/feature", &["a.txt".into()], true).unwrap();
    repo.add_review_comment("origin/feature", "a.txt", 2, "Why?").unwrap();
    assert_eq!((repo.review("origin/feature").unwrap().summary.viewed, repo.review("origin/feature").unwrap().summary.comments), (1, 1));

    // Merge into the local base. The remote branch stays, also when the user asks to delete it.
    let tip = git(&dir, &["rev-parse", "origin/feature"]);
    let r = repo.finish_review("origin/feature", FinishMode::Merge, "Merge origin/feature", true).unwrap();
    assert!(r.message.contains("stays because it is a remote branch"), "{}", r.message);
    assert_eq!(git(&dir, &["rev-parse", "origin/feature"]), tip);
    assert_eq!(git(&dir, &["rev-parse", "main^2"]), tip);
    assert!(git(&dir, &["branch", "--list", "origin/feature"]).is_empty());
    assert!(repo.review("origin/feature").unwrap().summary.merged);
}

#[test]
fn rebase_of_a_remote_branch_moves_the_base_only() {
    let dir = setup_remote("remote-rebase");
    let repo = Repo::open(&dir).unwrap();
    git(&dir, &["checkout", "-q", "--detach"]);
    repo.start_review("origin/feature", "main").unwrap();
    let tip = git(&dir, &["rev-parse", "origin/feature"]);
    repo.finish_review("origin/feature", FinishMode::Rebase, "", false).unwrap();
    assert_eq!(git(&dir, &["rev-parse", "origin/feature"]), tip);
    assert_eq!(git(&dir, &["log", "--format=%s", "-3", "main"]), "Add b\nChange a\nMain work");
}

#[test]
fn a_remote_base_shows_but_does_not_merge() {
    let dir = setup("remote-base");
    let repo = Repo::open(&dir).unwrap();
    let main = git(&dir, &["rev-parse", "main"]);
    git(&dir, &["update-ref", "refs/remotes/origin/main", &main]);
    repo.start_review("feature", "origin/main").unwrap();
    let d = repo.review("feature").unwrap();
    assert!(d.summary.base_is_remote && !d.summary.branch_is_remote);
    assert_eq!((d.summary.commits, d.summary.behind), (2, 1));
    let e = repo.finish_review("feature", FinishMode::Merge, "m", false).unwrap_err();
    assert!(e.0.contains("Merge needs a local base"), "{}", e.0);
    assert_eq!(git(&dir, &["rev-parse", "main"]), main);
}
