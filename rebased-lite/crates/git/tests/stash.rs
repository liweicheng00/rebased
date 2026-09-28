//! Runs stash operations against a temporary repository.

use rebased_git::Repo;
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn temp_repo(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("rebased-lite-stash-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "-b", "main"]);
    git(&dir, &["config", "user.name", "Test"]);
    git(&dir, &["config", "user.email", "test@example.com"]);
    for f in ["a.txt", "b.txt"] {
        std::fs::write(dir.join(f), format!("{f}\n")).unwrap();
    }
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-q", "-m", "Initial"]);
    dir
}

#[test]
fn stash_some_files_list_apply_pop_drop_branch() {
    let dir = temp_repo("flow");
    let repo = Repo::open(&dir).unwrap();
    assert!(repo.stashes().unwrap().is_empty());
    assert!(repo.stash_push("nothing", &[], false, false).is_err());

    std::fs::write(dir.join("a.txt"), "a2\n").unwrap();
    std::fs::write(dir.join("b.txt"), "b2\n").unwrap();
    std::fs::write(dir.join("new.txt"), "new\n").unwrap();
    // Stash a.txt and the untracked file only; b.txt stays.
    repo.stash_push("Part of the work", &["a.txt".into(), "new.txt".into()], true, false).unwrap();
    assert_eq!(git(&dir, &["status", "--porcelain"]), "M b.txt");
    let list = repo.stashes().unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!((list[0].branch.as_deref(), list[0].message.as_str()), (Some("main"), "Part of the work"));

    let d = repo.stash_detail(0).unwrap();
    assert_eq!(d.changes.len(), 1);
    assert_eq!(d.changes[0].path, "a.txt");
    assert_eq!(d.untracked, ["new.txt"]);
    assert!(d.untracked_oid.is_some());

    // Apply keeps the stash; drop removes it.
    git(&dir, &["checkout", "-q", "--", "b.txt"]);
    repo.stash_apply(0, false, false).unwrap();
    assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "a2\n");
    assert!(dir.join("new.txt").exists());
    assert_eq!(repo.stashes().unwrap().len(), 1);
    repo.stash_drop(0).unwrap();
    assert!(repo.stashes().unwrap().is_empty());

    // Stash everything, then pop.
    repo.stash_push("", &[], true, false).unwrap();
    assert_eq!(git(&dir, &["status", "--porcelain"]), "");
    repo.stash_apply(0, true, false).unwrap();
    assert!(repo.stashes().unwrap().is_empty());
    assert!(git(&dir, &["status", "--porcelain"]).contains("a.txt"));

    // A branch from a stash.
    repo.stash_push("For a branch", &[], true, false).unwrap();
    repo.stash_branch(0, "from-stash").unwrap();
    assert_eq!(git(&dir, &["branch", "--show-current"]), "from-stash");
    assert!(git(&dir, &["status", "--porcelain"]).contains("a.txt"));
    assert!(repo.stashes().unwrap().is_empty());
}

#[test]
fn pop_with_conflict_keeps_the_stash() {
    let dir = temp_repo("conflict");
    let repo = Repo::open(&dir).unwrap();
    std::fs::write(dir.join("a.txt"), "stashed\n").unwrap();
    repo.stash_push("Mine", &[], false, false).unwrap();
    std::fs::write(dir.join("a.txt"), "committed\n").unwrap();
    git(&dir, &["commit", "-q", "-am", "Change a"]);
    let r = repo.stash_apply(0, true, false).unwrap();
    assert!(!r.ok);
    assert_eq!(r.conflicts, ["a.txt"]);
    assert_eq!(repo.stashes().unwrap().len(), 1);
}
