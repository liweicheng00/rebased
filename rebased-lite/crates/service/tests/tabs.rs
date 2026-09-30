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

#[test]
fn commands_name_their_repository() {
    let (a, b) = (repo("scope-a", 1), repo("scope-b", 4));
    let s = Service::default();
    s.open(args(&a)).unwrap();
    s.open(args(&b)).unwrap();
    std::fs::write(a.join("f.txt"), "local\n").unwrap();
    let body = |p: &Path| serde_json::json!({ "root": p.to_string_lossy() }).to_string();
    // B is active; a command with the root of A reads A.
    let changes: serde_json::Value = serde_json::from_str(&s.dispatch("local_changes", &body(&a)).unwrap()).unwrap();
    assert_eq!(changes["lists"][0]["changes"].as_array().unwrap().len(), 1);
    let view: serde_json::Value = serde_json::from_str(&s.dispatch("refresh", &body(&a)).unwrap()).unwrap();
    assert_eq!(view["totalCommits"], 1);
    // The active tab stays B, and a command without a root uses it.
    let view: serde_json::Value = serde_json::from_str(&s.dispatch("refresh", "").unwrap()).unwrap();
    assert_eq!(view["totalCommits"], 4);
    // An operation on A reloads A and leaves B active.
    let op = serde_json::json!({ "root": a.to_string_lossy(), "op": "rollback", "paths": ["f.txt"] }).to_string();
    let out: serde_json::Value = serde_json::from_str(&s.dispatch("run_op", &op).unwrap()).unwrap();
    assert_eq!(out["result"]["ok"], true, "{out}");
    assert_eq!(out["view"]["totalCommits"], 1);
    assert_eq!(s.refresh().unwrap().total_commits, 4);
    // A repository that is not open is an error, not the active one.
    let other = serde_json::json!({ "root": "/no/such/repo" }).to_string();
    assert!(s.dispatch("local_changes", &other).is_err());
}

#[test]
fn favorites_are_stored_in_the_repository() {
    let a = repo("favorites", 1);
    let s = Service::default();
    s.open(args(&a)).unwrap();
    assert_eq!(s.favorites().unwrap(), None);
    s.set_favorites(vec!["refs/heads/main".into(), "refs/tags/v1".into()]).unwrap();
    assert_eq!(s.favorites().unwrap().unwrap(), ["refs/heads/main", "refs/tags/v1"]);
    // Another service, as after a restart, reads the same favorites.
    let t = Service::default();
    t.open(args(&a)).unwrap();
    assert_eq!(t.favorites().unwrap().unwrap().len(), 2);
}
