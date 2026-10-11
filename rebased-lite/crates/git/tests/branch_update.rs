//! Update Selected (a fast-forward of branches that are not checked out) and Checkout and Rebase onto
//! Current, with their Undo.

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

/// A clone with the branches a, b and c that track the origin. The origin then gets new commits on a
/// and b, and c gets a commit of its own in the clone.
fn setup(name: &str) -> (PathBuf, PathBuf, Repo) {
    let base = std::env::temp_dir().join(format!("rebased-lite-bupd-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let origin = base.join("origin");
    std::fs::create_dir_all(&origin).unwrap();
    git(&origin, &["init", "-q", "-b", "main"]);
    commit(&origin, "base.txt", "Base");
    for b in ["a", "b", "c"] {
        git(&origin, &["branch", b]);
    }
    let clone = base.join("clone");
    git(&base, &["clone", "-q", origin.to_str().unwrap(), clone.to_str().unwrap()]);
    for b in ["a", "b", "c"] {
        git(&clone, &["branch", "-q", "--track", b, &format!("origin/{b}")]);
    }
    for b in ["a", "b", "c"] {
        git(&origin, &["checkout", "-q", b]);
        commit(&origin, &format!("{b}.txt"), &format!("Upstream {b}"));
    }
    git(&clone, &["checkout", "-q", "c"]);
    commit(&clone, "mine.txt", "Mine on c");
    git(&clone, &["checkout", "-q", "main"]);
    let repo = Repo::open(&clone).unwrap();
    (base, clone, repo)
}

#[test]
fn fast_forward_branches_and_undo() {
    let (base, clone, repo) = setup("ff");
    let a_before = git(&clone, &["rev-parse", "a"]);
    let r = repo.fast_forward(&["a".into(), "b".into(), "c".into()]).unwrap();
    assert!(!r.ok, "c cannot fast-forward");
    assert!(r.message.starts_with("Updated 2 branches. Not updated: c (it has commits"), "{}", r.message);
    assert_eq!(git(&clone, &["log", "-1", "--format=%s", "a"]), "Upstream a");
    assert_eq!(git(&clone, &["log", "-1", "--format=%s", "b"]), "Upstream b");
    assert_eq!(git(&clone, &["log", "-1", "--format=%s", "c"]), "Mine on c");
    assert!(repo.apply_undo(&r.undo).unwrap().ok);
    assert_eq!(git(&clone, &["rev-parse", "a"]), a_before);
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn checkout_and_rebase_onto_current_and_undo() {
    let (base, clone, repo) = setup("cr");
    commit(&clone, "main.txt", "Main work");
    let c_before = git(&clone, &["rev-parse", "c"]);
    let r = repo.checkout_rebase("c", "main").unwrap();
    assert!(r.ok, "{}", r.message);
    assert_eq!(git(&clone, &["branch", "--show-current"]), "c");
    assert_eq!(git(&clone, &["log", "--format=%s", "-3"]), "Mine on c\nMain work\nBase");
    assert!(repo.apply_undo(&r.undo).unwrap().ok);
    assert_eq!(git(&clone, &["branch", "--show-current"]), "main");
    assert_eq!(git(&clone, &["rev-parse", "c"]), c_before);
    let _ = std::fs::remove_dir_all(&base);
}
