//! Runs changelists and partial commits against temporary repositories.

use rebased_git::changelist::{ChangeListOp, LocalChanges, DEFAULT_ID};
use rebased_git::ops::{UndoAction, UndoMode};
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
    assert!(r.ok);
    assert!(matches!(&r.undo[..], [UndoAction::Reset { to, mode: UndoMode::Soft, .. }] if *to == before));
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
    assert!(r.ok && matches!(&r.undo[..], [UndoAction::Reset { mode: UndoMode::Soft, .. }]), "{}", r.message);
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

#[test]
fn hunks_in_different_changelists() {
    let dir = temp_repo("hunks");
    git(&dir, &["config", "commit.gpgsign", "false"]);
    let base: String = (1..=20).map(|i| format!("line {i}\n")).collect();
    std::fs::write(dir.join("a.txt"), &base).unwrap();
    git(&dir, &["commit", "-q", "-am", "Twenty lines"]);
    let repo = Repo::open(&dir).unwrap();
    // Two changes: line 2 and line 18.
    let edited = base.replace("line 2\n", "line 2 fixed\n").replace("line 18\n", "line 18 debug\n");
    std::fs::write(dir.join("a.txt"), &edited).unwrap();
    repo.local_changes().unwrap();
    repo.changelist_op(ChangeListOp::Create { name: "Debug".into(), comment: String::new(), make_active: false, paths: vec![] }).unwrap();
    let lc = repo.local_changes().unwrap();
    let debug = id(&lc, "Debug");

    // Move the change at line 18 to Debug: the file is in both changelists.
    repo.changelist_op(ChangeListOp::MoveLines { path: "a.txt".into(), lines: vec![18], to: debug.clone() }).unwrap();
    let lc = repo.local_changes().unwrap();
    assert_eq!(list(&lc, "Changes"), ["a.txt"]);
    assert_eq!(list(&lc, "Debug"), ["a.txt"]);
    let hunks = &lc.hunks["a.txt"];
    assert_eq!(hunks.len(), 2);
    assert_eq!(hunks[0].list, DEFAULT_ID);
    assert_eq!(hunks[1].list, debug);

    // A new change goes to the owner of the file; the Debug hunk keeps its changelist.
    let edited = format!("new first line\n{edited}");
    std::fs::write(dir.join("a.txt"), &edited).unwrap();
    let lc = repo.local_changes().unwrap();
    let hunks = &lc.hunks["a.txt"];
    assert_eq!(hunks.iter().map(|h| h.list.as_str()).collect::<Vec<_>>(), [DEFAULT_ID, DEFAULT_ID, debug.as_str()]);

    // Commit the default changelist: only its hunks go in.
    let ids: Vec<String> = hunks.iter().filter(|h| h.list == DEFAULT_ID).map(|h| h.id.clone()).collect();
    let content = repo.content_with_hunks("a.txt", &ids).unwrap();
    let file = rebased_git::changelist::PartialFile { path: "a.txt".into(), content };
    let r = repo.commit_partial(&[], &[], &[file], "Fix line 2", false).unwrap();
    assert!(r.ok, "{}", r.message);
    let committed = git(&dir, &["show", "HEAD:a.txt"]);
    assert!(committed.starts_with("new first line\nline 1\nline 2 fixed\n"));
    assert!(committed.contains("line 18\n") && !committed.contains("debug"));
    assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), edited, "the working tree stays");

    // The rest is the Debug hunk only: Debug holds the whole file now.
    let lc = repo.local_changes().unwrap();
    assert!(list(&lc, "Changes").is_empty());
    assert_eq!(list(&lc, "Debug"), ["a.txt"]);
    assert!(lc.hunks.is_empty());

    // Move the hunk back, then move the whole file: no hunk entries stay.
    std::fs::write(dir.join("a.txt"), edited.replace("line 5\n", "line 5 more\n")).unwrap();
    repo.local_changes().unwrap();
    repo.changelist_op(ChangeListOp::MoveLines { path: "a.txt".into(), lines: vec![6], to: DEFAULT_ID.into() }).unwrap();
    assert_eq!(repo.local_changes().unwrap().hunks["a.txt"].len(), 2);
    repo.changelist_op(ChangeListOp::Move { paths: vec!["a.txt".into()], to: debug.clone() }).unwrap();
    let lc = repo.local_changes().unwrap();
    assert!(lc.hunks.is_empty());
    assert_eq!(list(&lc, "Debug"), ["a.txt"]);

    // Rollback of the Debug hunks keeps the other changelist's hunk.
    std::fs::write(dir.join("a.txt"), edited.replace("line 5\n", "line 5 more\n")).unwrap();
    repo.local_changes().unwrap();
    repo.changelist_op(ChangeListOp::MoveLines { path: "a.txt".into(), lines: vec![6], to: DEFAULT_ID.into() }).unwrap();
    let lc = repo.local_changes().unwrap();
    let ids: Vec<String> = lc.hunks["a.txt"].iter().filter(|h| h.list == debug).map(|h| h.id.clone()).collect();
    repo.rollback_hunks("a.txt", &ids).unwrap();
    let now = std::fs::read_to_string(dir.join("a.txt")).unwrap();
    assert!(now.contains("line 5 more\n") && !now.contains("debug"));

    // A line without a change is an error.
    assert!(repo.changelist_op(ChangeListOp::MoveLines { path: "a.txt".into(), lines: vec![12], to: DEFAULT_ID.into() }).is_err());
}

#[test]
fn commit_template_and_comment_lines() {
    let dir = temp_repo("template");
    git(&dir, &["config", "commit.gpgsign", "false"]);
    let repo = Repo::open(&dir).unwrap();
    assert!(repo.commit_template().is_none());
    std::fs::write(dir.join(".gitmessage"), "Subject\n\n# Why is this change needed?\n").unwrap();
    git(&dir, &["config", "commit.template", ".gitmessage"]);
    assert_eq!(repo.commit_template().as_deref(), Some("Subject\n\n# Why is this change needed?\n"));

    // A partial commit removes comment lines, as git commit does.
    std::fs::write(dir.join("a.txt"), "a.txt\nmore\n").unwrap();
    let file = rebased_git::changelist::PartialFile { path: "a.txt".into(), content: "a.txt\nmore\n".into() };
    let r = repo.commit_partial(&[], &[], &[file], "Real subject\n\n# a comment\nBody\n", false).unwrap();
    assert!(r.ok, "{}", r.message);
    assert_eq!(git(&dir, &["log", "-1", "--format=%B"]), "Real subject\n\nBody");
    // Only comments: refused.
    std::fs::write(dir.join("b.txt"), "changed\n").unwrap();
    let file = rebased_git::changelist::PartialFile { path: "b.txt".into(), content: "changed\n".into() };
    assert!(repo.commit_partial(&[], &[], &[file], "# only a comment\n", false).is_err());
}
