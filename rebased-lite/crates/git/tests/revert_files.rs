//! Revert to a revision and Write File: the file actions of a compare with the working tree.

use rebased_git::Repo;
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// main has a.txt and b.txt. The working tree changes a.txt, deletes b.txt, adds c.txt to the index and
/// leaves d.txt untracked.
fn setup(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("rebased-lite-revert-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "-b", "main"]);
    git(&dir, &["config", "user.name", "Me"]);
    git(&dir, &["config", "user.email", "me@example.com"]);
    git(&dir, &["config", "commit.gpgsign", "false"]);
    std::fs::write(dir.join("a.txt"), "one\ntwo\nthree\n").unwrap();
    std::fs::write(dir.join("b.txt"), "bee\n").unwrap();
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-q", "-m", "Base"]);
    std::fs::write(dir.join("a.txt"), "one\nTWO\nthree\nfour\n").unwrap();
    std::fs::remove_file(dir.join("b.txt")).unwrap();
    std::fs::write(dir.join("c.txt"), "new\n").unwrap();
    git(&dir, &["add", "c.txt"]);
    std::fs::write(dir.join("d.txt"), "untracked\n").unwrap();
    dir
}

#[test]
fn revert_makes_the_files_the_same_as_the_revision() {
    let dir = setup("rev");
    let repo = Repo::open(&dir).unwrap();
    let paths: Vec<String> = ["a.txt", "b.txt", "c.txt", "d.txt"].map(String::from).to_vec();
    let r = repo.revert_to_revision("main", &paths).unwrap();
    assert!(r.ok, "{}", r.message);
    assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "one\ntwo\nthree\n");
    assert_eq!(std::fs::read_to_string(dir.join("b.txt")).unwrap(), "bee\n");
    assert!(!dir.join("c.txt").exists() && !dir.join("d.txt").exists());
    // Nothing is left: the new file of the index left the index too.
    assert_eq!(git(&dir, &["status", "--porcelain"]), "");
}

#[test]
fn revert_refuses_a_path_outside_the_repository() {
    let dir = setup("outside");
    let repo = Repo::open(&dir).unwrap();
    assert!(repo.revert_to_revision("main", &["../x".into()]).is_err());
    assert!(repo.revert_to_revision("--help", &["a.txt".into()]).is_err());
}

#[test]
fn write_file_needs_the_text_that_the_caller_saw() {
    let dir = setup("write");
    let repo = Repo::open(&dir).unwrap();
    let seen = std::fs::read_to_string(dir.join("a.txt")).unwrap();
    // The user edits the file after the diff showed it: the write stops.
    std::fs::write(dir.join("a.txt"), "edited\n").unwrap();
    let e = repo.write_file("a.txt", "one\ntwo\nthree\nfour\n", &seen).unwrap_err();
    assert!(e.0.contains("changed on disk"), "{}", e.0);
    assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "edited\n");
    // With the text on disk, it writes.
    repo.write_file("a.txt", "one\ntwo\nthree\nfour\n", "edited\n").unwrap();
    assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "one\ntwo\nthree\nfour\n");
    assert!(repo.write_file("../a.txt", "x", "").is_err());
}
