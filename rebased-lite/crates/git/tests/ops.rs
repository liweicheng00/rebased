//! Runs the write operations against temporary repositories.

use rebased_git::ops::{Action, PlanEntry, ResetMode};
use rebased_git::Repo;
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(args).env("GIT_AUTHOR_DATE", "2026-01-01T00:00:00").output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn temp_repo(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("rebased-lite-ops-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "-b", "main"]);
    git(&dir, &["config", "user.name", "Test"]);
    git(&dir, &["config", "user.email", "test@example.com"]);
    dir
}

fn commit(dir: &Path, file: &str, content: &str, msg: &str) -> String {
    std::fs::write(dir.join(file), content).unwrap();
    git(dir, &["add", file]);
    git(dir, &["commit", "-q", "-m", msg]);
    git(dir, &["rev-parse", "HEAD"])
}

fn subjects(dir: &Path) -> Vec<String> {
    git(dir, &["log", "--format=%s"]).lines().map(String::from).collect()
}

fn entry(oid: &str, action: Action) -> PlanEntry {
    PlanEntry { oid: oid.into(), action, message: None }
}

#[test]
fn squash_drop_reword_and_undo() {
    let dir = temp_repo("rewrite");
    let base = commit(&dir, "a.txt", "1\n", "base");
    let c1 = commit(&dir, "a.txt", "1\n2\n", "one");
    let c2 = commit(&dir, "b.txt", "b\n", "two");
    let c3 = commit(&dir, "a.txt", "1\n2\n3\n", "three");
    // A local change must survive a rewrite that keeps the tree.
    std::fs::write(dir.join("local.txt"), "keep me").unwrap();
    let repo = Repo::open(&dir).unwrap();

    let range = repo.rewrite_range(&base).unwrap();
    assert_eq!(range.entries.len(), 3);
    assert!(!range.published);

    // squash two into one: the tree stays the same, so only the ref moves
    let head = git(&dir, &["rev-parse", "HEAD"]);
    let mut plan = vec![entry(&c1, Action::Pick), entry(&c2, Action::Squash), entry(&c3, Action::Pick)];
    plan[1].message = Some("one and two".into());
    let r = repo.rewrite(&base, &plan, "Squash").unwrap();
    assert!(r.ok, "{}", r.message);
    assert_eq!(subjects(&dir), vec!["three", "one and two", "base"]);
    assert_eq!(git(&dir, &["rev-parse", "HEAD^{tree}"]), git(&dir, &["rev-parse", &format!("{head}^{{tree}}")]));
    assert!(dir.join("local.txt").exists());

    // undo
    let new_head = git(&dir, &["rev-parse", "HEAD"]);
    repo.undo(r.undo_to.as_deref().unwrap(), &new_head, false).unwrap();
    assert_eq!(git(&dir, &["rev-parse", "HEAD"]), head);

    // drop "two": the tree changes, so the working tree is updated with reset --keep
    let plan = vec![entry(&c1, Action::Pick), entry(&c2, Action::Drop), entry(&c3, Action::Pick)];
    assert!(repo.rewrite(&base, &plan, "Drop").unwrap().ok);
    assert_eq!(subjects(&dir), vec!["three", "one", "base"]);
    assert!(!dir.join("b.txt").exists());
    assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "1\n2\n3\n");

    // reword the newest
    let range = repo.rewrite_range(&base).unwrap();
    let mut plan: Vec<PlanEntry> = range.entries.iter().map(|e| entry(&e.oid, Action::Pick)).collect();
    plan[1].action = Action::Reword;
    plan[1].message = Some("three, reworded".into());
    assert!(repo.rewrite(&base, &plan, "Reword").unwrap().ok);
    assert_eq!(subjects(&dir), vec!["three, reworded", "one", "base"]);
}

#[test]
fn conflicting_reorder_changes_nothing() {
    let dir = temp_repo("conflict");
    let base = commit(&dir, "a.txt", "1\n", "base");
    let c1 = commit(&dir, "a.txt", "2\n", "one");
    let c2 = commit(&dir, "a.txt", "3\n", "two");
    let repo = Repo::open(&dir).unwrap();
    let head = git(&dir, &["rev-parse", "HEAD"]);
    let err = repo.rewrite(&base, &[entry(&c2, Action::Pick), entry(&c1, Action::Pick)], "Reorder").unwrap_err();
    assert!(err.0.contains("conflicts"), "{}", err.0);
    assert_eq!(git(&dir, &["rev-parse", "HEAD"]), head);
}

#[test]
fn branches_merge_rebase_reset_cherry_pick_revert() {
    let dir = temp_repo("ops");
    let base = commit(&dir, "a.txt", "1\n", "base");
    let repo = Repo::open(&dir).unwrap();
    assert!(repo.create_branch("feature", &base, true).unwrap().ok);
    let f1 = commit(&dir, "f.txt", "f\n", "feature work");
    assert!(repo.checkout("main", "local").unwrap().ok);
    commit(&dir, "m.txt", "m\n", "main work");

    // merge
    let r = repo.merge("feature").unwrap();
    assert!(r.ok, "{}", r.message);
    assert_eq!(git(&dir, &["rev-list", "--parents", "-n1", "HEAD"]).split(' ').count(), 3);

    // reset --hard back, then rebase feature onto main
    assert!(repo.reset("HEAD~1", ResetMode::Hard).unwrap().ok);
    assert!(repo.checkout("feature", "local").unwrap().ok);
    assert!(repo.rebase("main").unwrap().ok);
    assert_eq!(subjects(&dir), vec!["feature work", "main work", "base"]);

    // cherry-pick and revert
    assert!(repo.checkout("main", "local").unwrap().ok);
    assert!(repo.cherry_pick(&[f1.clone()]).unwrap().ok);
    assert!(dir.join("f.txt").exists());
    let head = git(&dir, &["rev-parse", "HEAD"]);
    assert!(repo.revert(&[head]).unwrap().ok);
    assert!(!dir.join("f.txt").exists());

    // tags, rename and delete
    assert!(repo.create_tag("v1", "HEAD", "Release 1").unwrap().ok);
    assert!(repo.delete_tag("v1").unwrap().ok);
    assert!(repo.rename_branch("feature", "feat").unwrap().ok);
    assert!(repo.delete_branch("feat", true).unwrap().ok);
    assert!(repo.create_branch("bad name", "HEAD", false).is_err());

    // detached checkout
    assert!(repo.checkout(&base, "commit").unwrap().ok);
    assert!(repo.state().unwrap().branch.is_none());
}

#[test]
fn merge_conflict_then_abort() {
    let dir = temp_repo("merge-conflict");
    let base = commit(&dir, "a.txt", "1\n", "base");
    let repo = Repo::open(&dir).unwrap();
    repo.create_branch("other", &base, true).unwrap();
    commit(&dir, "a.txt", "other\n", "other change");
    repo.checkout("main", "local").unwrap();
    commit(&dir, "a.txt", "main\n", "main change");
    let r = repo.merge("other").unwrap();
    assert!(!r.ok);
    assert_eq!(r.conflicts, vec!["a.txt"]);
    let s = repo.state().unwrap();
    assert_eq!(s.operation, "merge");
    assert!(repo.continue_or_abort(false).is_err(), "continue must refuse while conflicts remain");
    assert!(repo.continue_or_abort(true).unwrap().ok);
    assert_eq!(repo.state().unwrap().operation, "none");
}

#[test]
fn worktrees_and_recent_branches() {
    let dir = temp_repo("worktree");
    let base = commit(&dir, "a.txt", "1\n", "base");
    let repo = Repo::open(&dir).unwrap();
    repo.create_branch("one", &base, true).unwrap();
    repo.create_branch("two", &base, true).unwrap();
    repo.checkout("one", "local").unwrap();
    repo.checkout("main", "local").unwrap();
    let recent: Vec<String> = repo.recent_branches(10).unwrap().into_iter().map(|b| b.name).collect();
    assert_eq!(recent, vec!["one", "two"], "newest first, without the current branch");

    let wt = dir.with_extension("wt");
    let _ = std::fs::remove_dir_all(&wt);
    repo.add_worktree(wt.to_str().unwrap(), "side", true, &base).unwrap();
    let list = repo.worktrees().unwrap();
    assert_eq!(list.len(), 2);
    assert!(list[0].main && list[0].current);
    assert_eq!(list[1].branch.as_deref(), Some("side"));
    repo.remove_worktree(wt.to_str().unwrap(), false).unwrap();
    assert_eq!(repo.worktrees().unwrap().len(), 1);
}
