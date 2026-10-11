//! The options of Merge and Update: --no-ff, --ff-only, --squash, --no-commit and a message.

use rebased_git::ops::MergeOptions;
use rebased_git::remote::{UpdateMode, UpdateOptions};
use rebased_git::Repo;
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(["-c", "user.name=Me", "-c", "user.email=me@example.com", "-c", "commit.gpgsign=false"]).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn commit(dir: &Path, file: &str, msg: &str) {
    std::fs::write(dir.join(file), msg).unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", msg]);
}

fn setup(name: &str) -> (PathBuf, Repo) {
    let dir = std::env::temp_dir().join(format!("rebased-lite-mopt-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "-b", "main"]);
    git(&dir, &["config", "user.name", "Me"]);
    git(&dir, &["config", "user.email", "me@example.com"]);
    commit(&dir, "a.txt", "Base");
    git(&dir, &["checkout", "-q", "-b", "topic"]);
    commit(&dir, "t.txt", "Topic work");
    git(&dir, &["checkout", "-q", "main"]);
    let repo = Repo::open(&dir).unwrap();
    (dir, repo)
}

#[test]
fn merge_options() {
    let (dir, repo) = setup("merge");
    // --no-ff with a message: a merge commit, also where a fast-forward works.
    let r = repo.merge_with("topic", &MergeOptions { no_ff: true, message: "Merge the topic".into(), ..Default::default() }).unwrap();
    assert!(r.ok, "{}", r.message);
    assert_eq!(git(&dir, &["log", "-1", "--format=%p"]).split(' ').count(), 2, "two parents");
    assert_eq!(git(&dir, &["log", "-1", "--format=%s"]), "Merge the topic");
    git(&dir, &["reset", "-q", "--hard", "HEAD~1"]);

    // --squash: the changes are local changes, and HEAD stays.
    let head = git(&dir, &["rev-parse", "HEAD"]);
    let r = repo.merge_with("topic", &MergeOptions { squash: true, ..Default::default() }).unwrap();
    assert!(r.ok && r.message.contains("Commit them"), "{}", r.message);
    assert_eq!(git(&dir, &["rev-parse", "HEAD"]), head);
    assert_eq!(git(&dir, &["status", "--porcelain"]), "A  t.txt");
    git(&dir, &["reset", "-q", "--hard"]);

    // --ff-only: main has a commit of its own now, so nothing changes.
    commit(&dir, "m.txt", "Main work");
    let head = git(&dir, &["rev-parse", "HEAD"]);
    let r = repo.merge_with("topic", &MergeOptions { ff_only: true, ..Default::default() }).unwrap();
    assert!(!r.ok && r.message.contains("cannot fast-forward"), "{}", r.message);
    assert_eq!(git(&dir, &["rev-parse", "HEAD"]), head);

    // --no-commit: the merge waits for its commit.
    let r = repo.merge_with("topic", &MergeOptions { no_commit: true, ..Default::default() }).unwrap();
    assert!(r.ok, "{}", r.message);
    assert!(dir.join(".git/MERGE_HEAD").exists());
    assert_eq!(git(&dir, &["rev-parse", "HEAD"]), head);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn update_fast_forward_only() {
    let (dir, _) = setup("update");
    let clone = dir.with_extension("clone");
    let _ = std::fs::remove_dir_all(&clone);
    git(&dir, &["clone", "-q", dir.to_str().unwrap(), clone.to_str().unwrap()]);
    git(&clone, &["config", "user.name", "Me"]);
    git(&clone, &["config", "user.email", "me@example.com"]);
    commit(&dir, "u.txt", "Upstream work");
    commit(&clone, "c.txt", "Clone work");
    let repo = Repo::open(&clone).unwrap();
    let head = git(&clone, &["rev-parse", "HEAD"]);
    let r = repo.update_with(UpdateMode::Merge, &UpdateOptions { ff_only: true, ..Default::default() }).unwrap();
    assert!(!r.ok && r.message.contains("cannot fast-forward"), "{}", r.message);
    assert_eq!(git(&clone, &["rev-parse", "HEAD"]), head);
    let r = repo.update_with(UpdateMode::Merge, &UpdateOptions::default()).unwrap();
    assert!(r.ok, "{}", r.message);
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&clone);
}
