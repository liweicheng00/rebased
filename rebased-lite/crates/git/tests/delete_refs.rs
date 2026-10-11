//! Delete of several branches and tags in one operation: git keeps a branch that is not merged without
//! force, and undo creates all deleted refs again with their settings.

use rebased_git::Repo;
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(["-c", "user.name=Me", "-c", "user.email=me@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"]).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn setup() -> (PathBuf, Repo) {
    let dir = std::env::temp_dir().join(format!("rebased-lite-delrefs-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "-b", "main"]);
    std::fs::write(dir.join("a.txt"), "a\n").unwrap();
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-q", "-m", "Base"]);
    git(&dir, &["branch", "merged-1"]);
    git(&dir, &["branch", "merged-2"]);
    git(&dir, &["config", "branch.merged-2.description", "kept by undo"]);
    git(&dir, &["checkout", "-q", "-b", "open"]);
    std::fs::write(dir.join("b.txt"), "b\n").unwrap();
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-q", "-m", "Open work"]);
    git(&dir, &["checkout", "-q", "main"]);
    git(&dir, &["tag", "-a", "-m", "Release", "v1"]);
    let repo = Repo::open(&dir).unwrap();
    (dir, repo)
}

fn exists(dir: &Path, full: &str) -> bool {
    Command::new("git").arg("-C").arg(dir).args(["rev-parse", "-q", "--verify", full]).output().unwrap().status.success()
}

#[test]
fn deletes_several_refs_and_undo_creates_them_again() {
    let (dir, repo) = setup();
    let names = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let tag_oid = git(&dir, &["rev-parse", "refs/tags/v1"]);

    // Without force: the merged branches and the tag go, the open branch stays and is named.
    let r = repo.delete_refs(&names(&["merged-1", "merged-2", "open"]), &names(&["v1"]), false).unwrap();
    assert!(!r.ok);
    assert!(r.message.starts_with("Not merged, so kept: open"), "{}", r.message);
    assert!(r.message.contains("Deleted 3 of 4"), "{}", r.message);
    assert!(!exists(&dir, "refs/heads/merged-1") && !exists(&dir, "refs/heads/merged-2") && !exists(&dir, "refs/tags/v1"));
    assert!(exists(&dir, "refs/heads/open"));

    // Undo creates them again: the annotated tag keeps its tag object, the branch its settings.
    assert!(repo.apply_undo(&r.undo).unwrap().ok);
    assert!(exists(&dir, "refs/heads/merged-1") && exists(&dir, "refs/heads/merged-2"));
    assert_eq!(git(&dir, &["rev-parse", "refs/tags/v1"]), tag_oid);
    assert_eq!(git(&dir, &["config", "branch.merged-2.description"]), "kept by undo");

    // With force, the open branch goes too.
    let r = repo.delete_refs(&names(&["open"]), &[], true).unwrap();
    assert!(r.ok, "{}", r.message);
    assert_eq!(r.message, "Deleted 1 branch or tag");
    assert!(!exists(&dir, "refs/heads/open"));
    let _ = std::fs::remove_dir_all(&dir);
}
