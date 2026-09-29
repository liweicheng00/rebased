//! Runs the repository watcher against a temporary repository.

use rebased_git::Repo;
use rebased_service::history::{Limits, LocalHistory};
use rebased_service::watch::RepoWatcher;
use std::path::Path;
use std::sync::Arc;
use std::process::Command;
use std::time::{Duration, Instant};

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

/// Waits until `f` is true or two seconds pass.
fn eventually(f: impl Fn() -> bool) -> bool {
    let end = Instant::now() + Duration::from_secs(2);
    while Instant::now() < end {
        if f() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    f()
}

#[test]
fn counters_follow_files_and_refs() {
    let dir = std::env::temp_dir().join(format!("rebased-lite-watch-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("target")).unwrap();
    git(&dir, &["init", "-q", "-b", "main"]);
    git(&dir, &["config", "user.name", "Test"]);
    git(&dir, &["config", "user.email", "test@example.com"]);
    std::fs::write(dir.join(".gitignore"), "target/\n*.log\n").unwrap();
    std::fs::write(dir.join("a.txt"), "a\n").unwrap();
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-q", "-m", "Initial"]);
    let repo = Repo::open(&dir).unwrap();
    let history = Arc::new(LocalHistory::open(&repo.root, &repo.git_dir(), Limits::default()));
    let w = RepoWatcher::start(&repo.root, &repo.git_dir(), &repo.common_dir(), Some(history.clone())).unwrap();
    let recorded = |p: &str| !history.revisions(Some(p), 10).is_empty();
    std::thread::sleep(Duration::from_millis(400));
    let c0 = w.state.counters();

    // Ignored files do not count.
    std::fs::write(dir.join("build.log"), "x\n").unwrap();
    std::fs::write(dir.join("target").join("out.bin"), "x\n").unwrap();
    std::thread::sleep(Duration::from_millis(800));
    assert_eq!(w.state.counters().files, c0.files, "ignored files must not count");

    // A changed tracked file counts, and Local History keeps a version.
    std::fs::write(dir.join("a.txt"), "a2\n").unwrap();
    assert!(eventually(|| w.state.counters().files > c0.files));
    assert!(eventually(|| recorded("a.txt")));
    assert_eq!(w.state.counters().repo, c0.repo);

    // A commit made outside the app counts as a repository change.
    git(&dir, &["commit", "-q", "-am", "Outside"]);
    assert!(eventually(|| w.state.counters().repo > c0.repo));

    // A file in a new directory counts.
    let c1 = w.state.counters();
    std::fs::create_dir_all(dir.join("src/deep")).unwrap();
    std::thread::sleep(Duration::from_millis(500));
    std::fs::write(dir.join("src/deep/new.rs"), "fn main() {}\n").unwrap();
    assert!(eventually(|| w.state.counters().files > c1.files));
    assert!(eventually(|| recorded("src/deep/new.rs")));
    assert!(!recorded("build.log") && !recorded("target"));

    // Reads by the app do not count: they must not write the index.
    let c2 = w.state.counters();
    repo.local_changes().unwrap();
    repo.state().unwrap();
    std::thread::sleep(Duration::from_millis(800));
    assert_eq!(w.state.counters().files, c2.files, "reads must not refresh the index");
}
