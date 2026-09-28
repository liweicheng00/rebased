//! Runs conflict resolution against temporary repositories.

use rebased_git::merge::Side;
use rebased_git::Repo;
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A merge of `side` into `main` that conflicts in a.txt (both edit), b.txt (both edit) and gone.txt
/// (deleted on main, edited on side).
fn conflicted(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("rebased-lite-merge-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "-b", "main"]);
    git(&dir, &["config", "user.name", "Test"]);
    git(&dir, &["config", "user.email", "test@example.com"]);
    std::fs::write(dir.join("a.txt"), "one\ntwo\nthree\n").unwrap();
    std::fs::write(dir.join("b.txt"), "b\n").unwrap();
    std::fs::write(dir.join("gone.txt"), "gone\n").unwrap();
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-q", "-m", "Base"]);
    git(&dir, &["checkout", "-q", "-b", "side"]);
    std::fs::write(dir.join("a.txt"), "one\nTWO (side)\nthree\n").unwrap();
    std::fs::write(dir.join("b.txt"), "b side\n").unwrap();
    std::fs::write(dir.join("gone.txt"), "gone, edited\n").unwrap();
    git(&dir, &["commit", "-q", "-am", "Side"]);
    git(&dir, &["checkout", "-q", "main"]);
    std::fs::write(dir.join("a.txt"), "one\ntwo (main)\nthree\n").unwrap();
    std::fs::write(dir.join("b.txt"), "b main\n").unwrap();
    git(&dir, &["rm", "-q", "gone.txt"]);
    git(&dir, &["commit", "-q", "-am", "Main"]);
    let out = Command::new("git").arg("-C").arg(&dir).args(["merge", "side"]).output().unwrap();
    assert!(!out.status.success());
    dir
}

#[test]
fn sides_labels_and_resolution() {
    let dir = conflicted("resolve");
    let repo = Repo::open(&dir).unwrap();
    let s = repo.merge_sides("a.txt").unwrap();
    assert_eq!(s.base.text.as_deref(), Some("one\ntwo\nthree\n"));
    assert_eq!(s.ours.text.as_deref(), Some("one\ntwo (main)\nthree\n"));
    assert_eq!(s.theirs.text.as_deref(), Some("one\nTWO (side)\nthree\n"));
    assert_eq!(s.ours.label, "Yours (main)");
    assert_eq!(s.theirs.label, "Theirs (side)");
    assert!(!s.binary);

    let g = repo.merge_sides("gone.txt").unwrap();
    assert!(g.ours.text.is_none());
    assert_eq!(g.theirs.text.as_deref(), Some("gone, edited\n"));
    assert!(repo.merge_sides("nope.txt").is_err());

    repo.resolve_with_text("a.txt", "one\ntwo (both)\nthree\n").unwrap();
    assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "one\ntwo (both)\nthree\n");
    repo.resolve_with_side(&["b.txt".into()], Side::Theirs).unwrap();
    assert_eq!(std::fs::read_to_string(dir.join("b.txt")).unwrap(), "b side\n");
    // Yours deleted gone.txt: taking yours removes it.
    repo.resolve_with_side(&["gone.txt".into()], Side::Ours).unwrap();
    assert!(!dir.join("gone.txt").exists());
    assert_eq!(git(&dir, &["diff", "--name-only", "--diff-filter=U"]), "");
    assert!(repo.continue_or_abort(false).unwrap().ok);
    assert_eq!(git(&dir, &["rev-list", "--parents", "-n", "1", "HEAD"]).split(' ').count(), 3);
}

#[test]
fn rebase_labels() {
    let dir = conflicted("rebase");
    git(&dir, &["merge", "--abort"]);
    git(&dir, &["checkout", "-q", "side"]);
    let out = Command::new("git").arg("-C").arg(&dir).args(["rebase", "main"]).output().unwrap();
    assert!(!out.status.success());
    let repo = Repo::open(&dir).unwrap();
    let s = repo.merge_sides("a.txt").unwrap();
    assert!(s.ours.label.starts_with("Rebase base: ") && s.ours.label.ends_with("Main"), "{}", s.ours.label);
    assert!(s.theirs.label.starts_with("Your commit: ") && s.theirs.label.ends_with("Side"), "{}", s.theirs.label);
    assert_eq!(s.ours.text.as_deref(), Some("one\ntwo (main)\nthree\n"));
}
