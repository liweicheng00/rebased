//! History edits of the log: drop or extract the changes of files from a commit, push up to a commit,
//! and a rebase with options.

use rebased_git::ops::RebaseOptions;
use rebased_git::Repo;
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(["-c", "user.name=Me", "-c", "user.email=me@example.com", "-c", "commit.gpgsign=false"]).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn commit(dir: &Path, files: &[(&str, &str)], msg: &str) {
    for (p, t) in files {
        std::fs::write(dir.join(p), t).unwrap();
    }
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", msg]);
}

fn setup(name: &str) -> (PathBuf, Repo) {
    let dir = std::env::temp_dir().join(format!("rebased-lite-hedit-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "-b", "main"]);
    git(&dir, &["config", "user.name", "Me"]);
    git(&dir, &["config", "user.email", "me@example.com"]);
    commit(&dir, &[("a.txt", "a\n")], "Base");
    commit(&dir, &[("a.txt", "a2\n"), ("b.txt", "b\n"), ("c.txt", "c\n")], "Mixed work");
    commit(&dir, &[("a.txt", "a3\n")], "Later");
    let repo = Repo::open(&dir).unwrap();
    (dir, repo)
}

fn files_of(dir: &Path, rev: &str) -> String {
    git(dir, &["diff-tree", "--no-commit-id", "--name-only", "-r", rev]).replace('\n', ",")
}

#[test]
fn drop_selected_changes() {
    let (dir, repo) = setup("drop");
    let mixed = git(&dir, &["rev-parse", "HEAD~1"]);
    let r = repo.rewrite_files(&mixed, &["b.txt".into(), "c.txt".into()], None).unwrap();
    assert!(r.ok, "{}", r.message);
    assert_eq!(files_of(&dir, "HEAD~1"), "a.txt", "the commit keeps only a.txt");
    assert_eq!(git(&dir, &["log", "--format=%s", "-3"]), "Later\nMixed work\nBase");
    assert!(!dir.join("b.txt").exists(), "the working tree follows the branch");
    assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "a3\n");
    assert!(repo.apply_undo(&r.undo).unwrap().ok);
    assert_eq!(files_of(&dir, "HEAD~1"), "a.txt,b.txt,c.txt");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn extract_selected_changes() {
    let (dir, repo) = setup("extract");
    let mixed = git(&dir, &["rev-parse", "HEAD~1"]);
    let r = repo.rewrite_files(&mixed, &["b.txt".into()], Some("Add b")).unwrap();
    assert!(r.ok, "{}", r.message);
    assert_eq!(git(&dir, &["log", "--format=%s", "-4"]), "Later\nAdd b\nMixed work\nBase");
    assert_eq!(files_of(&dir, "HEAD~1"), "b.txt");
    assert_eq!(files_of(&dir, "HEAD~2"), "a.txt,c.txt");
    assert_eq!(git(&dir, &["log", "--format=%an", "-1", "HEAD~1"]), "Me", "the new commit keeps the author");
    assert!(repo.rewrite_files(&mixed, &[], None).is_err(), "no files");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn push_up_to_a_commit() {
    let (dir, repo) = setup("push");
    let origin = dir.with_extension("origin.git");
    let _ = std::fs::remove_dir_all(&origin);
    git(&dir, &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
    git(&dir, &["remote", "add", "origin", origin.to_str().unwrap()]);
    let mixed = git(&dir, &["rev-parse", "HEAD~1"]);
    let r = repo.push_rev("main", Some(&mixed), "origin", "main", false, true, false).unwrap();
    assert!(r.ok, "{}", r.message);
    assert_eq!(git(&origin, &["rev-parse", "main"]), mixed, "the remote has the commits up to Mixed work");
    assert!(repo.push_rev("main", Some("0000000"), "origin", "main", false, false, false).is_err());
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&origin);
}

#[test]
fn rebase_with_onto_and_autosquash() {
    let (dir, repo) = setup("rebase");
    // feature: two commits on Mixed work, one a fixup of the first.
    git(&dir, &["checkout", "-q", "-b", "feature", "HEAD~1"]);
    commit(&dir, &[("f.txt", "f\n")], "Feature");
    commit(&dir, &[("f.txt", "f2\n")], "fixup! Feature");
    let o = RebaseOptions { autosquash: true, ..Default::default() };
    let r = repo.rebase_with("main", &o).unwrap();
    assert!(r.ok, "{}", r.message);
    assert_eq!(git(&dir, &["log", "--format=%s", "-3"]), "Feature\nLater\nMixed work", "the fixup joined its commit");
    assert_eq!(std::fs::read_to_string(dir.join("f.txt")).unwrap(), "f2\n");
    // --onto: only the commits after Later move onto Base.
    let base = git(&dir, &["rev-parse", "main~2"]);
    let r = repo.rebase_with(&base, &RebaseOptions { from: "main".into(), ..Default::default() }).unwrap();
    assert!(r.ok, "{}", r.message);
    assert_eq!(git(&dir, &["log", "--format=%s", "-2"]), "Feature\nBase");
    let _ = std::fs::remove_dir_all(&dir);
}
