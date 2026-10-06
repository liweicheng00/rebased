//! Clone Repository: the folder name from the URL, the clone, and the checks before it.

use rebased_git::{clone, clone_name};
use std::path::Path;
use std::process::Command;

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

#[test]
fn the_name_comes_from_the_url() {
    assert_eq!(clone_name("https://github.com/acme/demo.git"), "demo");
    assert_eq!(clone_name("https://github.com/acme/demo/"), "demo");
    assert_eq!(clone_name("git@github.com:acme/tool.git"), "tool");
    assert_eq!(clone_name("git@host:repo.git"), "repo");
    assert_eq!(clone_name("/srv/git/project.git"), "project");
}

#[test]
fn clone_makes_the_folder_and_checks_it_first() {
    let base = std::env::temp_dir().join(format!("rebased-lite-clone-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let origin = base.join("origin");
    std::fs::create_dir_all(&origin).unwrap();
    git(&origin, &["init", "-q", "-b", "main"]);
    std::fs::write(origin.join("a.txt"), "a\n").unwrap();
    git(&origin, &["add", "."]);
    git(&origin, &["-c", "user.name=Me", "-c", "user.email=me@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "Base"]);
    let parent = base.join("work");
    std::fs::create_dir_all(&parent).unwrap();
    let url = origin.to_string_lossy().to_string();

    let path = clone(&url, &parent, "").unwrap();
    assert_eq!(path, parent.join("origin"));
    assert!(path.join("a.txt").is_file());

    // The folder exists now and is not empty.
    assert!(clone(&url, &parent, "").unwrap_err().0.contains("not empty"));
    // An empty folder is fine, and a name of the user wins.
    std::fs::create_dir_all(parent.join("copy")).unwrap();
    assert!(clone(&url, &parent, "copy").unwrap().join("a.txt").is_file());
    // Bad input stops before git runs.
    assert!(clone("", &parent, "x").is_err());
    assert!(clone("--upload-pack=touch", &parent, "x").is_err());
    assert!(clone(&url, &parent, "../out").is_err());
    assert!(clone(&url, &base.join("missing"), "x").is_err());
    // An error of git comes back.
    assert!(clone(&base.join("nothing").to_string_lossy(), &parent, "y").is_err());
    let _ = std::fs::remove_dir_all(&base);
}
