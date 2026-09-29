//! Every operation that can be undone gives Undo steps that bring the repository back.

use rebased_git::Repo;
use rebased_service::{Op, OpenArgs, Service, ViewArgs};
use std::path::Path;
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn op(s: &Service, json: &str) -> rebased_git::ops::OpResult {
    let op: Op = serde_json::from_str(json).unwrap();
    let r = s.run_op(op).unwrap().result;
    assert!(r.ok, "{json}: {}", r.message);
    r
}

fn undo(s: &Service, r: &rebased_git::ops::OpResult) {
    assert!(!r.undo.is_empty(), "{} has no undo", r.message);
    let actions = serde_json::to_string(&r.undo).unwrap();
    let u = s.run_op(serde_json::from_str(&format!(r#"{{"op":"undo","actions":{actions}}}"#)).unwrap()).unwrap().result;
    assert!(u.ok, "{}", u.message);
}

#[test]
fn undo_for_each_operation() {
    let dir = std::env::temp_dir().join(format!("rebased-lite-undo-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "-b", "main"]);
    git(&dir, &["config", "user.name", "Test"]);
    git(&dir, &["config", "user.email", "test@example.com"]);
    git(&dir, &["config", "commit.gpgsign", "false"]);
    for (f, m) in [("a.txt", "A"), ("b.txt", "B")] {
        std::fs::write(dir.join(f), format!("{f}\n")).unwrap();
        git(&dir, &["add", f]);
        git(&dir, &["commit", "-q", "-m", m]);
    }
    git(&dir, &["branch", "side", "HEAD~1"]);
    git(&dir, &["tag", "-a", "-m", "Release one", "v1", "HEAD~1"]);
    let s = Service::default();
    s.open(OpenArgs { path: dir.to_string_lossy().into(), view: ViewArgs::default() }).unwrap();
    let main = git(&dir, &["rev-parse", "main"]);
    let branch = || git(&dir, &["branch", "--show-current"]);

    // Checkout, then back.
    let r = op(&s, r#"{"op":"checkout","target":"side","kind":"local"}"#);
    assert_eq!(branch(), "side");
    undo(&s, &r);
    assert_eq!(branch(), "main");

    // A new branch that was checked out: back to main, and the branch is gone.
    let r = op(&s, r#"{"op":"createBranch","name":"topic","at":"HEAD","checkout":true}"#);
    assert_eq!(branch(), "topic");
    undo(&s, &r);
    assert_eq!(branch(), "main");
    assert!(git(&dir, &["branch", "--list", "topic"]).is_empty());

    // Rename and delete a branch.
    let r = op(&s, r#"{"op":"renameBranch","from":"side","to":"renamed"}"#);
    undo(&s, &r);
    assert!(!git(&dir, &["branch", "--list", "side"]).is_empty());
    let side = git(&dir, &["rev-parse", "side"]);
    let r = op(&s, r#"{"op":"deleteBranch","name":"side","force":true}"#);
    undo(&s, &r);
    assert_eq!(git(&dir, &["rev-parse", "side"]), side);

    // An annotated tag comes back with its message.
    let tag_object = git(&dir, &["rev-parse", "v1"]);
    let r = op(&s, r#"{"op":"deleteTag","name":"v1"}"#);
    undo(&s, &r);
    assert_eq!(git(&dir, &["rev-parse", "v1"]), tag_object);
    assert_eq!(git(&dir, &["tag", "-l", "--format=%(contents:subject)", "v1"]), "Release one");
    let r = op(&s, r#"{"op":"createTag","name":"v2","at":"HEAD","message":""}"#);
    undo(&s, &r);
    assert!(git(&dir, &["tag", "-l", "v2"]).is_empty());

    // A hard reset: the commit comes back with its files.
    let r = op(&s, r#"{"op":"reset","to":"HEAD~1","mode":"hard"}"#);
    assert!(!dir.join("b.txt").exists());
    undo(&s, &r);
    assert_eq!(git(&dir, &["rev-parse", "HEAD"]), main);
    assert!(dir.join("b.txt").exists());

    // A mixed reset: the index comes back, the working tree does not change.
    std::fs::write(dir.join("local.txt"), "local\n").unwrap();
    let r = op(&s, r#"{"op":"reset","to":"HEAD~1","mode":"mixed"}"#);
    undo(&s, &r);
    assert_eq!(git(&dir, &["rev-parse", "HEAD"]), main);
    assert_eq!(git(&dir, &["status", "--porcelain"]), "?? local.txt");

    // A merge.
    std::fs::write(dir.join("c.txt"), "c\n").unwrap();
    git(&dir, &["checkout", "-q", "side"]);
    git(&dir, &["add", "c.txt"]);
    git(&dir, &["commit", "-q", "-m", "C"]);
    git(&dir, &["checkout", "-q", "main"]);
    let r = op(&s, r#"{"op":"merge","rev":"side"}"#);
    assert_ne!(git(&dir, &["rev-parse", "HEAD"]), main);
    undo(&s, &r);
    assert_eq!(git(&dir, &["rev-parse", "HEAD"]), main);

    // A dropped stash comes back.
    std::fs::write(dir.join("a.txt"), "stashed\n").unwrap();
    git(&dir, &["stash", "push", "-q", "-m", "keep me"]);
    let r = op(&s, r#"{"op":"stashDrop","index":0}"#);
    assert!(git(&dir, &["stash", "list"]).is_empty());
    undo(&s, &r);
    assert!(git(&dir, &["stash", "list"]).contains("keep me"));

    // Undo refuses when HEAD moved after the operation.
    let r = op(&s, r#"{"op":"checkout","target":"side","kind":"local"}"#);
    git(&dir, &["checkout", "-q", "main"]);
    let actions = serde_json::to_string(&r.undo).unwrap();
    let u = s.run_op(serde_json::from_str(&format!(r#"{{"op":"undo","actions":{actions}}}"#)).unwrap()).unwrap().result;
    assert!(!u.ok && u.message.contains("HEAD changed"), "{}", u.message);
    let _ = Repo::open(&dir);
}
