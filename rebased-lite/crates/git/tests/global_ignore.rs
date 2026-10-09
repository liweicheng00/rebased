//! The global ignore file: git finds it, a save makes it and refuses to overwrite a change from outside,
//! and check-ignore names the pattern that decides about a path. The test uses its own HOME, so the
//! file of the user stays as it is.

use rebased_git::global_ignore::{global_ignore, save_global_ignore};
use rebased_git::Repo;
use std::path::Path;
use std::process::Command;

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git").arg("-C").arg(dir).args(["-c", "user.name=Me", "-c", "user.email=me@example.com", "-c", "commit.gpgsign=false"]).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

// One test: the environment of the process is shared, and the steps depend on each other.
#[test]
fn global_ignore_file() {
    let base = std::env::temp_dir().join(format!("rebased-lite-gi-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let home = base.join("home");
    std::fs::create_dir_all(&home).unwrap();
    std::env::set_var("HOME", &home);
    std::env::remove_var("XDG_CONFIG_HOME");
    std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");

    // The default file, before it exists.
    let first = global_ignore().unwrap();
    let default = home.join(".config/git/ignore");
    assert_eq!(first.path, default.to_string_lossy());
    assert!(!first.exists && !first.configured && first.text.is_empty());

    // A save makes the folder and the file, and ends the text with a newline.
    let saved = save_global_ignore(".idea/\n.DS_Store", "").unwrap();
    assert!(saved.exists);
    assert_eq!(std::fs::read_to_string(&default).unwrap(), ".idea/\n.DS_Store\n");

    // A change from outside stops a save with an old text.
    std::fs::write(&default, ".idea/\n.DS_Store\n*.log\n").unwrap();
    let err = save_global_ignore(".vscode/\n", &saved.text).unwrap_err();
    assert!(err.to_string().contains("changed outside"), "{err}");
    assert_eq!(std::fs::read_to_string(&default).unwrap(), ".idea/\n.DS_Store\n*.log\n");

    // check-ignore names the global file, a .gitignore, or nothing.
    let repo_dir = base.join("repo");
    std::fs::create_dir_all(&repo_dir).unwrap();
    git(&repo_dir, &["init", "-q", "-b", "main"]);
    std::fs::write(repo_dir.join(".gitignore"), "build/\n!keep.log\n").unwrap();
    let repo = Repo::open(&repo_dir).unwrap();
    let m = repo.check_ignore(".idea/workspace.xml").unwrap().unwrap();
    assert!(m.ignored);
    assert_eq!((m.source.as_str(), m.line, m.pattern.as_str()), (default.to_str().unwrap(), 1, ".idea/"));
    let m = repo.check_ignore("build/out.o").unwrap().unwrap();
    assert_eq!((m.source.as_str(), m.line, m.ignored), (".gitignore", 1, true));
    let m = repo.check_ignore("keep.log").unwrap().unwrap();
    assert!(!m.ignored, "a negative pattern does not ignore");
    assert_eq!(repo.check_ignore("src/main.rs").unwrap(), None);

    // core.excludesFile names another file, with ~.
    git(&repo_dir, &["config", "--global", "core.excludesFile", "~/my-ignore"]);
    let other = global_ignore().unwrap();
    assert!(other.configured && !other.exists);
    assert_eq!(other.path, home.join("my-ignore").to_string_lossy());
    save_global_ignore("*.tmp\n", "").unwrap();
    assert_eq!(repo.check_ignore("a.tmp").unwrap().unwrap().source, home.join("my-ignore").to_string_lossy());
    assert_eq!(repo.check_ignore(".idea/x").unwrap(), None, "git no longer reads the default file");
    let _ = std::fs::remove_dir_all(&base);
}
