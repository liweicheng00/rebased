//! The text options of the log filter: a regular expression, the same case, and no merge commits.

use rebased_git::{LogFilter, Repo};
use std::path::Path;
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(["-c", "user.name=Me", "-c", "user.email=me@example.com", "-c", "commit.gpgsign=false"]).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

#[test]
fn regex_match_case_and_no_merges() {
    let dir = std::env::temp_dir().join(format!("rebased-lite-logfilter-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "-b", "main"]);
    git(&dir, &["commit", "-q", "--allow-empty", "-m", "Fix bug 12"]);
    git(&dir, &["checkout", "-q", "-b", "side"]);
    git(&dir, &["commit", "-q", "--allow-empty", "-m", "fix typo"]);
    git(&dir, &["checkout", "-q", "main"]);
    git(&dir, &["commit", "-q", "--allow-empty", "-m", "Add docs"]);
    git(&dir, &["merge", "-q", "--no-ff", "-m", "Merge side: Fix more", "side"]);
    let repo = Repo::open(&dir).unwrap();
    let count = |f: LogFilter| repo.matching_commits(&f, &[]).unwrap().len();
    let text = |t: &str| LogFilter { text: t.into(), ..Default::default() };

    assert_eq!(count(text("fix")), 3, "a fixed string ignores the case");
    assert_eq!(count(text("bug [0-9]+")), 0, "a fixed string does not take a pattern");
    assert_eq!(count(LogFilter { regex: true, ..text("bug [0-9]+") }), 1);
    assert_eq!(count(LogFilter { match_case: true, ..text("Fix") }), 2, "the same case only");
    assert_eq!(count(LogFilter { no_merges: true, ..text("fix") }), 2, "no merge commits");
    assert!(LogFilter { no_merges: true, ..Default::default() }.needs_git());
    let _ = std::fs::remove_dir_all(&dir);
}
