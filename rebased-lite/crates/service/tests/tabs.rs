//! Several repositories open at one time, one per tab.

use rebased_service::{OpenArgs, PathArgs, Service, ViewArgs};
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

fn repo(name: &str, commits: usize) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("rebased-lite-tabs-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "-b", "main"]);
    git(&dir, &["config", "user.name", "Test"]);
    git(&dir, &["config", "user.email", "test@example.com"]);
    git(&dir, &["config", "commit.gpgsign", "false"]);
    for i in 0..commits {
        std::fs::write(dir.join("f.txt"), format!("{i}\n")).unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-q", "-m", &format!("C{i}")]);
    }
    dir
}

fn args(p: &Path) -> OpenArgs {
    OpenArgs { path: p.to_string_lossy().into(), view: ViewArgs::default() }
}

#[test]
fn tabs() {
    let (a, b) = (repo("a", 2), repo("b", 3));
    let s = Service::default();
    assert_eq!(s.open(args(&a)).unwrap().total_commits, 2);
    assert_eq!(s.open(args(&b)).unwrap().total_commits, 3);
    // The last opened repository is active.
    assert_eq!(s.refresh().unwrap().total_commits, 3);

    // Activate switches without a reload; the commands then use that repository.
    std::fs::write(a.join("f.txt"), "local\n").unwrap();
    let v = s.activate(args(&a)).unwrap();
    assert_eq!(v.total_commits, 2);
    assert_eq!(s.local_changes().unwrap().lists[0].changes.len(), 1);
    s.activate(args(&b)).unwrap();
    assert!(s.local_changes().unwrap().lists[0].changes.is_empty());

    // Closing the active tab leaves no active repository; the other tab stays open.
    s.close(PathArgs { path: b.to_string_lossy().into() }).unwrap();
    assert!(s.local_changes().is_err());
    assert_eq!(s.activate(args(&a)).unwrap().total_commits, 2);
    // A closed repository opens again on activate.
    assert_eq!(s.activate(args(&b)).unwrap().total_commits, 3);
}
