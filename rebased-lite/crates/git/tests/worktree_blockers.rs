//! What stops the removal of a worktree: files that git counts, submodules, and a lock. These are the
//! checks of `git worktree remove` without --force.

use rebased_git::Repo;
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(["-c", "user.name=Me", "-c", "user.email=me@example.com", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always"]).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn setup(name: &str) -> (PathBuf, Repo) {
    let dir = std::env::temp_dir().join(format!("rebased-lite-wtb-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(dir.with_extension("wt"));
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "-b", "main"]);
    std::fs::write(dir.join(".gitignore"), "build/\n").unwrap();
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-q", "-m", "Base"]);
    let repo = Repo::open(&dir).unwrap();
    (dir, repo)
}

fn add_worktree(dir: &Path, name: &str) -> String {
    let wt = dir.with_extension(format!("wt-{name}"));
    let _ = std::fs::remove_dir_all(&wt);
    git(dir, &["worktree", "add", "-q", "-b", name, wt.to_str().unwrap()]);
    wt.to_string_lossy().into_owned()
}

#[test]
fn a_clean_worktree_has_no_blockers_and_ignored_files_do_not_count() {
    let (dir, repo) = setup("clean");
    let wt = add_worktree(&dir, "clean");
    std::fs::create_dir_all(Path::new(&wt).join("build")).unwrap();
    std::fs::write(Path::new(&wt).join("build/out.o"), "x").unwrap();
    let b = repo.worktree_blockers(&wt).unwrap();
    assert!(b.clean(), "{b:?}");
    repo.remove_worktree(&wt, false, false).unwrap();
}

#[test]
fn an_untracked_file_that_no_gitignore_covers_counts() {
    let (dir, repo) = setup("untracked");
    let wt = add_worktree(&dir, "untracked");
    std::fs::write(Path::new(&wt).join(".DS_Store"), "x").unwrap();
    std::fs::create_dir_all(Path::new(&wt).join(".idea")).unwrap();
    std::fs::write(Path::new(&wt).join(".idea/workspace.xml"), "x").unwrap();
    let b = repo.worktree_blockers(&wt).unwrap();
    assert_eq!(b.files, ["?? .DS_Store", "?? .idea/"]);
    // Git refuses, as the check says.
    assert!(repo.remove_worktree(&wt, false, false).unwrap_err().0.contains("modified or untracked"));
    repo.remove_worktree(&wt, true, false).unwrap();
}

#[test]
fn a_long_list_shows_its_first_files_and_a_count() {
    let (dir, repo) = setup("many");
    let wt = add_worktree(&dir, "many");
    for i in 0..20 {
        std::fs::write(Path::new(&wt).join(format!("f{i:02}.txt")), "x").unwrap();
    }
    let b = repo.worktree_blockers(&wt).unwrap();
    assert_eq!((b.files.len(), b.more), (15, 5));
}

#[test]
fn a_submodule_blocks_also_when_it_is_clean() {
    let (dir, repo) = setup("sub");
    let wt = add_worktree(&dir, "sub");
    git(Path::new(&wt), &["submodule", "add", "-q", dir.to_str().unwrap(), "inner"]);
    git(Path::new(&wt), &["commit", "-q", "-m", "Sub"]);
    let b = repo.worktree_blockers(&wt).unwrap();
    assert!(b.submodules && b.files.is_empty(), "{b:?}");
    assert!(repo.remove_worktree(&wt, false, false).unwrap_err().0.contains("submodules"));
    repo.remove_worktree(&wt, true, false).unwrap();
}

#[test]
fn a_lock_shows_its_reason_and_unlock_removes_it() {
    let (dir, repo) = setup("lock");
    let wt = add_worktree(&dir, "lock");
    git(&dir, &["worktree", "lock", "--reason", "on a USB disk", &wt]);
    assert_eq!(repo.worktree_blockers(&wt).unwrap().locked.as_deref(), Some("on a USB disk"));
    assert!(repo.remove_worktree(&wt, false, false).is_err());
    repo.remove_worktree(&wt, false, true).unwrap();
    assert!(!Path::new(&wt).exists());
}
