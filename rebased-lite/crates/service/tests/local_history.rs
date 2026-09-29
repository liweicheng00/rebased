//! Local History keeps versions of changed files and the content before an operation that loses it.

use rebased_service::{OpenArgs, PathArgs, Service, ViewArgs};
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

fn wait_for(what: &str, mut f: impl FnMut() -> bool) {
    let start = Instant::now();
    while !f() {
        assert!(start.elapsed() < Duration::from_secs(10), "timed out: {what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn versions_and_revert() {
    let dir = std::env::temp_dir().join(format!("rebased-lite-history-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "-b", "main"]);
    git(&dir, &["config", "user.name", "Test"]);
    git(&dir, &["config", "user.email", "test@example.com"]);
    git(&dir, &["config", "commit.gpgsign", "false"]);
    std::fs::write(dir.join(".gitignore"), "build/\n").unwrap();
    std::fs::write(dir.join("a.txt"), "one\n").unwrap();
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-q", "-m", "A"]);
    let s = Service::default();
    s.open(OpenArgs { path: dir.to_string_lossy().into(), view: ViewArgs::default() }).unwrap();
    let revs = |p: &str| s.local_history(PathArgs { path: p.into() }).unwrap();

    // Each save on disk adds a version. An ignored file adds none.
    std::fs::create_dir_all(dir.join("build")).unwrap();
    std::fs::write(dir.join("a.txt"), "two\n").unwrap();
    wait_for("the first version", || revs("a.txt").len() == 1);
    std::fs::write(dir.join("build/out.o"), "x").unwrap();
    std::fs::write(dir.join("a.txt"), "three\n").unwrap();
    wait_for("the second version", || revs("a.txt").len() == 2);
    assert!(revs("build").is_empty());
    let text = |blob: &Option<String>| s.local_history_content(serde_json::from_str(&serde_json::json!({ "blob": blob }).to_string()).unwrap()).unwrap().text;
    assert_eq!(text(&revs("a.txt")[0].blob).as_deref(), Some("three\n"));
    assert_eq!(text(&revs("a.txt")[1].blob).as_deref(), Some("two\n"));

    // Rollback loses the change; Local History keeps it with a label.
    let op = |json: &str| {
        let r = s.run_op(serde_json::from_str(json).unwrap()).unwrap().result;
        assert!(r.ok, "{json}: {}", r.message);
    };
    op(r#"{"op":"rollback","paths":["a.txt"]}"#);
    assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "one\n");
    let before = revs("a.txt").into_iter().find(|r| r.label == "Before Rollback").expect("a version before the rollback");
    assert_eq!(text(&before.blob).as_deref(), Some("three\n"));

    // A new file that is deleted as unversioned comes back.
    std::fs::write(dir.join("new.txt"), "new\n").unwrap();
    op(r#"{"op":"deleteUnversioned","paths":["new.txt"]}"#);
    let kept = revs("new.txt").into_iter().find(|r| r.label == "Before Delete").unwrap();
    let revert = serde_json::json!({ "op": "revertLocalHistory", "path": "new.txt", "blob": kept.blob }).to_string();
    op(&revert);
    assert_eq!(std::fs::read_to_string(dir.join("new.txt")).unwrap(), "new\n");

    // A hard reset keeps all changed files first.
    std::fs::write(dir.join("a.txt"), "local work\n").unwrap();
    op(r#"{"op":"reset","to":"HEAD","mode":"hard"}"#);
    let hard = revs("").into_iter().find(|r| r.label == "Before Hard Reset").unwrap();
    assert_eq!(hard.path, "a.txt");
    assert_eq!(text(&hard.blob).as_deref(), Some("local work\n"));

    // Nothing of the store shows as a local change.
    let status = Command::new("git").arg("-C").arg(&dir).args(["status", "--porcelain"]).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&status.stdout).trim(), "?? new.txt");
}
