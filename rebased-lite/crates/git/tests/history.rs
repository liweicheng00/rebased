//! Runs file history and blame against a temporary repository.

use rebased_git::Repo;
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(dir: &Path, args: &[&str], author: &str) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_AUTHOR_NAME", author)
        .env("GIT_AUTHOR_EMAIL", "a@example.com")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn repo() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("rebased-lite-history-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "-b", "main"], "x");
    git(&dir, &["config", "user.name", "Committer"], "x");
    git(&dir, &["config", "user.email", "c@example.com"], "x");
    std::fs::write(dir.join("old.txt"), "one\ntwo\nthree\nfour\nfive\nsix\n").unwrap();
    std::fs::write(dir.join("other.txt"), "x\n").unwrap();
    git(&dir, &["add", "."], "x");
    git(&dir, &["commit", "-q", "-m", "Add old.txt"], "Ada");
    std::fs::write(dir.join("old.txt"), "one\nTWO\nthree\nfour\nfive\nsix\n").unwrap();
    git(&dir, &["commit", "-q", "-am", "Change two"], "Grace");
    std::fs::write(dir.join("other.txt"), "y\n").unwrap();
    git(&dir, &["commit", "-q", "-am", "Change other"], "Grace");
    git(&dir, &["mv", "old.txt", "new.txt"], "x");
    git(&dir, &["commit", "-q", "-m", "Rename"], "Linus");
    std::fs::write(dir.join("new.txt"), "one\nTWO\nthree\nfour\nFIVE\nsix\n").unwrap();
    git(&dir, &["commit", "-q", "-am", "Change five"], "Linus");
    dir
}

#[test]
fn history_follows_renames_and_blame_names_authors() {
    let dir = repo();
    let repo = Repo::open(&dir).unwrap();
    let h = repo.file_history("new.txt").unwrap();
    let subjects: Vec<&str> = h.iter().map(|e| e.subject.as_str()).collect();
    assert_eq!(subjects, ["Change five", "Rename", "Change two", "Add old.txt"]);
    assert_eq!((h[1].status.as_str(), h[1].path.as_str(), h[1].old_path.as_deref()), ("R", "new.txt", Some("old.txt")));
    assert_eq!((h[2].status.as_str(), h[2].path.as_str()), ("M", "old.txt"));
    assert_eq!((h[3].status.as_str(), h[3].path.as_str()), ("A", "old.txt"));
    assert_eq!(h[3].parents.len(), 0);

    let b = repo.blame(Some("HEAD"), "new.txt").unwrap();
    assert_eq!(b.lines.len(), 6);
    let author = |line: usize| b.commits[b.lines[line] as usize].author.as_str();
    assert_eq!([author(0), author(1), author(4)], ["Ada", "Grace", "Linus"]);
    assert_eq!(b.commits[b.lines[1] as usize].summary, "Change two");

    // The working tree: a changed line is not committed yet.
    std::fs::write(dir.join("new.txt"), "one\nTWO\nthree\nfour\nFIVE\nsix!\n").unwrap();
    let b = repo.blame(None, "new.txt").unwrap();
    assert!(b.commits[b.lines[5] as usize].uncommitted);
    assert!(!b.commits[b.lines[0] as usize].uncommitted);
    // An older revision under the old name.
    let old = repo.blame(Some(&h[2].oid), "old.txt").unwrap();
    assert_eq!(old.lines.len(), 6);
    assert!(repo.blame(None, "-x").is_err());
}
