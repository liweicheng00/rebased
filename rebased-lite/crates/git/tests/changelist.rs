//! Runs changelists and partial commits against temporary repositories.

use rebased_git::changelist::{ChangeListOp, LocalChanges, DEFAULT_ID};
use rebased_git::Repo;
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn temp_repo(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("rebased-lite-cl-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "-b", "main"]);
    git(&dir, &["config", "user.name", "Test"]);
    git(&dir, &["config", "user.email", "test@example.com"]);
    for f in ["a.txt", "b.txt", "c.txt", "gone.txt", "old.txt"] {
        std::fs::write(dir.join(f), format!("{f}\n")).unwrap();
    }
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-q", "-m", "Initial"]);
    dir
}

fn list<'a>(lc: &'a LocalChanges, name: &str) -> Vec<&'a str> {
    lc.lists.iter().find(|l| l.name == name).unwrap().changes.iter().map(|c| c.path.as_str()).collect()
}

fn id(lc: &LocalChanges, name: &str) -> String {
    lc.lists.iter().find(|l| l.name == name).unwrap().id.clone()
}

fn strings(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

#[test]
fn changelists_assign_move_and_remove() {
    let dir = temp_repo("assign");
    let repo = Repo::open(&dir).unwrap();
    std::fs::write(dir.join("a.txt"), "a2\n").unwrap();
    let lc = repo.local_changes().unwrap();
    assert_eq!(list(&lc, "Changes"), ["a.txt"]);

    // A new changelist becomes active: the next new change goes there.
    repo.changelist_op(ChangeListOp::Create { name: "Feature".into(), comment: String::new(), make_active: true, paths: vec![] }).unwrap();
    std::fs::write(dir.join("b.txt"), "b2\n").unwrap();
    let lc = repo.local_changes().unwrap();
    assert_eq!(list(&lc, "Changes"), ["a.txt"]);
    assert_eq!(list(&lc, "Feature"), ["b.txt"]);
    assert!(lc.lists.iter().find(|l| l.name == "Feature").unwrap().active);

    // Move, then a duplicate name is refused.
    let feature = id(&lc, "Feature");
    repo.changelist_op(ChangeListOp::Move { paths: strings(&["a.txt"]), to: feature.clone() }).unwrap();
    assert_eq!(list(&repo.local_changes().unwrap(), "Feature"), ["a.txt", "b.txt"]);
    assert!(repo.changelist_op(ChangeListOp::Create { name: "Feature".into(), comment: String::new(), make_active: false, paths: vec![] }).is_err());

    // A file that is not changed any more leaves its changelist; when it changes again it goes to the active one.
    repo.changelist_op(ChangeListOp::SetActive { id: DEFAULT_ID.into() }).unwrap();
    std::fs::write(dir.join("a.txt"), "a.txt\n").unwrap();
    assert_eq!(list(&repo.local_changes().unwrap(), "Feature"), ["b.txt"]);
    std::fs::write(dir.join("a.txt"), "a3\n").unwrap();
    assert_eq!(list(&repo.local_changes().unwrap(), "Changes"), ["a.txt"]);

    // Removing a changelist moves its files to the active changelist.
    repo.changelist_op(ChangeListOp::Remove { id: feature }).unwrap();
    let lc = repo.local_changes().unwrap();
    assert_eq!(lc.lists.len(), 1);
    assert_eq!(list(&lc, "Changes"), ["a.txt", "b.txt"]);
    assert!(repo.changelist_op(ChangeListOp::Remove { id: DEFAULT_ID.into() }).is_err());

    // The draft message is kept.
    repo.changelist_op(ChangeListOp::SaveMessage { id: DEFAULT_ID.into(), message: "Draft".into() }).unwrap();
    assert_eq!(repo.local_changes().unwrap().lists[0].comment, "Draft");
}

#[test]
fn commit_one_changelist_only() {
    let dir = temp_repo("commit");
    let repo = Repo::open(&dir).unwrap();
    std::fs::write(dir.join("a.txt"), "a2\n").unwrap();
    std::fs::write(dir.join("b.txt"), "b2\n").unwrap();
    // c.txt is staged; it must stay staged and out of the commit.
    std::fs::write(dir.join("c.txt"), "c2\n").unwrap();
    git(&dir, &["add", "c.txt"]);
    git(&dir, &["rm", "-q", "gone.txt"]);
    git(&dir, &["mv", "old.txt", "new.txt"]);
    std::fs::write(dir.join("fresh.txt"), "fresh\n").unwrap();
    let lc = repo.local_changes().unwrap();
    assert_eq!(list(&lc, "Changes"), ["a.txt", "b.txt", "c.txt", "gone.txt", "new.txt"]);
    assert_eq!(lc.unversioned, ["fresh.txt"]);
    let renamed = &lc.lists[0].changes[4];
    assert_eq!((renamed.status, renamed.old_path.as_deref()), ('R', Some("old.txt")));

    repo.changelist_op(ChangeListOp::Create {
        name: "Later".into(),
        comment: String::new(),
        make_active: false,
        paths: strings(&["b.txt", "c.txt"]),
    })
    .unwrap();
    let lc = repo.local_changes().unwrap();
    assert_eq!(list(&lc, "Changes"), ["a.txt", "gone.txt", "new.txt"]);

    let before = git(&dir, &["rev-parse", "HEAD"]);
    let r = repo.commit_paths(&strings(&["a.txt", "gone.txt", "new.txt", "old.txt"]), &strings(&["fresh.txt"]), "Commit the default list", false).unwrap();
    assert!(r.ok && r.undo_soft);
    assert_eq!(r.undo_to.as_deref(), Some(before.as_str()));
    let files = git(&dir, &["show", "--name-status", "--format=", "HEAD"]);
    assert_eq!(files, "M\ta.txt\nA\tfresh.txt\nD\tgone.txt\nR100\told.txt\tnew.txt");
    // The other changelist is untouched, and c.txt is still staged.
    assert_eq!(git(&dir, &["diff", "--cached", "--name-only"]), "c.txt");
    assert_eq!(git(&dir, &["diff", "--name-only"]), "b.txt");
    let lc = repo.local_changes().unwrap();
    assert!(list(&lc, "Changes").is_empty());
    assert_eq!(list(&lc, "Later"), ["b.txt", "c.txt"]);
    assert!(lc.unversioned.is_empty());

    // Amend the message only.
    let head = git(&dir, &["rev-parse", "HEAD"]);
    repo.commit_paths(&[], &[], "Better message", true).unwrap();
    assert_eq!(repo.head_message().unwrap(), "Better message");
    assert_eq!(git(&dir, &["rev-parse", "HEAD^"]), before);
    assert_ne!(git(&dir, &["rev-parse", "HEAD"]), head);

    // Undo the commit: its changes are local changes again.
    let head = git(&dir, &["rev-parse", "HEAD"]);
    repo.undo(&before, &head, true).unwrap();
    assert_eq!(git(&dir, &["rev-parse", "HEAD"]), before);
    assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "a2\n");
    let lc = repo.local_changes().unwrap();
    assert_eq!(list(&lc, "Later"), ["b.txt", "c.txt"]);
    assert_eq!(list(&lc, "Changes"), ["a.txt", "fresh.txt", "gone.txt", "new.txt"]);

    // Empty message and path traversal are refused.
    assert!(repo.commit_paths(&strings(&["a.txt"]), &[], "  ", false).is_err());
    assert!(repo.commit_paths(&strings(&["../x"]), &[], "x", false).is_err());
}

#[test]
fn rollback_add_and_delete() {
    let dir = temp_repo("rollback");
    let repo = Repo::open(&dir).unwrap();
    std::fs::write(dir.join("a.txt"), "a2\n").unwrap();
    std::fs::write(dir.join("added.txt"), "added\n").unwrap();
    git(&dir, &["add", "a.txt", "added.txt"]);
    std::fs::write(dir.join("a.txt"), "a3\n").unwrap();
    std::fs::write(dir.join("junk.txt"), "junk\n").unwrap();

    repo.rollback(&strings(&["a.txt", "added.txt"])).unwrap();
    assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "a.txt\n");
    assert!(!dir.join("added.txt").exists());
    assert_eq!(git(&dir, &["status", "--porcelain"]), "?? junk.txt");

    assert!(repo.delete_unversioned(&strings(&["a.txt"])).is_err());
    repo.add_files(&strings(&["junk.txt"])).unwrap();
    assert_eq!(git(&dir, &["status", "--porcelain"]), "A  junk.txt");
    git(&dir, &["rm", "-q", "--cached", "junk.txt"]);
    repo.delete_unversioned(&strings(&["junk.txt"])).unwrap();
    assert_eq!(git(&dir, &["status", "--porcelain"]), "");
}

#[test]
fn commit_during_merge_takes_the_whole_index() {
    let dir = temp_repo("merge");
    let repo = Repo::open(&dir).unwrap();
    git(&dir, &["checkout", "-q", "-b", "side"]);
    std::fs::write(dir.join("a.txt"), "side\n").unwrap();
    git(&dir, &["commit", "-q", "-am", "Side"]);
    git(&dir, &["checkout", "-q", "main"]);
    std::fs::write(dir.join("a.txt"), "main\n").unwrap();
    git(&dir, &["commit", "-q", "-am", "Main"]);
    let out = Command::new("git").arg("-C").arg(&dir).args(["merge", "side"]).output().unwrap();
    assert!(!out.status.success());
    let lc = repo.local_changes().unwrap();
    assert_eq!(lc.conflicts, ["a.txt"]);
    assert_eq!(lc.lists[0].changes[0].status, 'U');
    std::fs::write(dir.join("a.txt"), "resolved\n").unwrap();
    repo.commit_paths(&strings(&["a.txt"]), &[], "Merge side", false).unwrap();
    assert_eq!(git(&dir, &["rev-list", "--parents", "-n", "1", "HEAD"]).split(' ').count(), 3);
    assert_eq!(git(&dir, &["status", "--porcelain"]), "");
}

#[test]
fn partial_commit_takes_the_given_content() {
    use rebased_git::changelist::PartialFile;
    let dir = temp_repo("partial");
    let repo = Repo::open(&dir).unwrap();
    std::fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
    git(&dir, &["commit", "-q", "-am", "Two lines"]);
    // The working tree has two changes; only the first one goes into the commit.
    std::fs::write(dir.join("a.txt"), "ONE\ntwo\nthree\n").unwrap();
    std::fs::write(dir.join("b.txt"), "b2\n").unwrap();
    std::fs::write(dir.join("c.txt"), "c2\n").unwrap();
    git(&dir, &["add", "c.txt"]);
    let before = git(&dir, &["rev-parse", "HEAD"]);
    let r = repo
        .commit_partial(&strings(&["b.txt"]), &[], &[PartialFile { path: "a.txt".into(), content: "ONE\ntwo\n".into() }], "Part of a", false)
        .unwrap();
    assert!(r.ok && r.undo_soft, "{}", r.message);
    assert_eq!(git(&dir, &["show", "HEAD:a.txt"]), "ONE\ntwo");
    assert_eq!(git(&dir, &["show", "--name-only", "--format=", "HEAD"]), "a.txt\nb.txt");
    assert_eq!(git(&dir, &["rev-parse", "HEAD^"]), before);
    // The rest of a.txt stays a local change; c.txt stays staged; the working tree did not change.
    assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "ONE\ntwo\nthree\n");
    assert_eq!(git(&dir, &["diff", "--name-only"]), "a.txt");
    assert_eq!(git(&dir, &["diff", "--cached", "--name-only"]), "c.txt");
    assert_eq!(git(&dir, &["log", "-1", "--format=%s"]), "Part of a");

    // Amend with another part keeps the author and the parent.
    let r = repo
        .commit_partial(&[], &[], &[PartialFile { path: "a.txt".into(), content: "ONE\ntwo\nthree\n".into() }], "All of a", true)
        .unwrap();
    assert!(r.ok);
    assert_eq!(git(&dir, &["rev-parse", "HEAD^"]), before);
    assert_eq!(git(&dir, &["diff", "--name-only"]), "");
    assert!(repo.commit_partial(&[], &[], &[PartialFile { path: "../x".into(), content: String::new() }], "x", false).is_err());
}
