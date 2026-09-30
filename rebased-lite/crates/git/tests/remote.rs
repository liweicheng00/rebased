//! Runs push and update against a local bare remote.

use rebased_git::remote::UpdateMode;
use rebased_git::Repo;
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn setup(name: &str) -> (PathBuf, PathBuf, PathBuf) {
    let base = std::env::temp_dir().join(format!("rebased-lite-remote-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    let origin = base.join("origin.git");
    git(&base, &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
    let seed = base.join("seed");
    git(&base, &["clone", "-q", origin.to_str().unwrap(), seed.to_str().unwrap()]);
    for d in [&seed] {
        git(d, &["config", "user.name", "Test"]);
        git(d, &["config", "user.email", "test@example.com"]);
    }
    git(&seed, &["checkout", "-q", "-b", "main"]);
    std::fs::write(seed.join("a.txt"), "1\n").unwrap();
    git(&seed, &["add", "."]);
    git(&seed, &["commit", "-q", "-m", "Initial"]);
    git(&seed, &["push", "-q", "-u", "origin", "main"]);
    let mine = base.join("mine");
    git(&base, &["clone", "-q", origin.to_str().unwrap(), mine.to_str().unwrap()]);
    git(&mine, &["config", "user.name", "Me"]);
    git(&mine, &["config", "user.email", "me@example.com"]);
    (origin, seed, mine)
}

fn commit(dir: &Path, file: &str, content: &str, msg: &str) {
    std::fs::write(dir.join(file), content).unwrap();
    git(dir, &["add", file]);
    git(dir, &["commit", "-q", "-m", msg]);
}

#[test]
fn push_reject_update_and_push_again() {
    let (_origin, seed, mine) = setup("push");
    let repo = Repo::open(&mine).unwrap();
    commit(&mine, "b.txt", "b\n", "Mine");
    let info = repo.push_info(None).unwrap();
    assert_eq!((info.branch.as_str(), info.remote.as_deref(), info.remote_branch.as_str()), ("main", Some("origin"), "main"));
    assert_eq!(info.upstream.as_deref(), Some("origin/main"));
    assert_eq!(info.outgoing.len(), 1);
    assert_eq!(info.outgoing[0].subject, "Mine");
    assert!(!info.new_branch);

    // Somebody else pushes first: the push is rejected.
    commit(&seed, "c.txt", "c\n", "Theirs");
    git(&seed, &["push", "-q"]);
    let r = repo.push("main", "origin", "main", false, false, false).unwrap();
    assert!(!r.ok && r.message.contains("rejected"), "{}", r.message);

    // Update with rebase keeps a local change and makes the history linear.
    std::fs::write(mine.join("a.txt"), "local edit\n").unwrap();
    let r = repo.update(UpdateMode::Rebase).unwrap();
    assert!(r.ok, "{}", r.message);
    assert_eq!(git(&mine, &["log", "--format=%s"]), "Mine\nTheirs\nInitial");
    assert_eq!(std::fs::read_to_string(mine.join("a.txt")).unwrap(), "local edit\n");
    assert_eq!(repo.push_info(None).unwrap().behind, 0);
    let r = repo.push("main", "origin", "main", false, false, false).unwrap();
    assert!(r.ok, "{}", r.message);
    assert!(repo.push_info(None).unwrap().outgoing.is_empty());

    // Update with merge.
    commit(&seed, "d.txt", "d\n", "Theirs 2");
    git(&seed, &["pull", "-q", "--rebase"]);
    commit(&seed, "e.txt", "e\n", "Theirs 3");
    git(&seed, &["push", "-q"]);
    git(&mine, &["checkout", "-q", "--", "a.txt"]);
    commit(&mine, "f.txt", "f\n", "Mine 2");
    let r = repo.update(UpdateMode::Merge).unwrap();
    assert!(r.ok, "{}", r.message);
    assert_eq!(git(&mine, &["rev-list", "--parents", "-n", "1", "HEAD"]).split(' ').count(), 3);
}

#[test]
fn new_branch_force_push_and_conflict() {
    let (_origin, seed, mine) = setup("branch");
    let repo = Repo::open(&mine).unwrap();
    git(&mine, &["checkout", "-q", "-b", "feature"]);
    commit(&mine, "x.txt", "x\n", "Feature 1");
    commit(&mine, "y.txt", "y\n", "Feature 2");
    let info = repo.push_info(None).unwrap();
    assert!(info.new_branch && info.upstream.is_none());
    assert_eq!(info.remote_branch, "feature");
    assert_eq!(info.outgoing.len(), 2);
    assert!(repo.update(UpdateMode::Merge).is_err(), "no tracked branch");
    assert!(repo.push("feature", "origin", "feature", false, true, false).unwrap().ok);
    assert_eq!(repo.push_info(None).unwrap().upstream.as_deref(), Some("origin/feature"));

    // Amend, then a normal push is rejected and a force push with lease works.
    git(&mine, &["commit", "-q", "--amend", "-m", "Feature 2 amended"]);
    assert!(!repo.push("feature", "origin", "feature", false, false, false).unwrap().ok);
    assert!(repo.push("feature", "origin", "feature", true, false, false).unwrap().ok);

    // A conflicting update stops with conflicts.
    git(&mine, &["checkout", "-q", "main"]);
    commit(&mine, "a.txt", "mine\n", "Mine");
    commit(&seed, "a.txt", "theirs\n", "Theirs");
    git(&seed, &["push", "-q"]);
    let r = repo.update(UpdateMode::Rebase).unwrap();
    assert!(!r.ok);
    assert_eq!(r.conflicts, ["a.txt"]);
    assert_eq!(repo.state().unwrap().operation, "rebase");
    assert!(repo.continue_or_abort(true).unwrap().ok);
}

#[test]
fn manage_remotes_tags_and_tracking() {
    let (origin, _seed, mine) = setup("manage");
    let repo = Repo::open(&mine).unwrap();
    git(&mine, &["config", "commit.gpgsign", "false"]);
    let details = repo.remote_details().unwrap();
    assert_eq!(details.len(), 1);
    assert_eq!(details[0].name, "origin");
    assert_eq!(details[0].fetch_url, origin.to_str().unwrap());
    assert!(details[0].push_url.is_none());

    // Add a second remote, fetch only it, rename it, give it a push URL, and remove it.
    let backup = origin.parent().unwrap().join("backup.git");
    git(origin.parent().unwrap(), &["clone", "-q", "--bare", origin.to_str().unwrap(), backup.to_str().unwrap()]);
    assert!(repo.add_remote("backup", backup.to_str().unwrap()).unwrap().ok);
    assert!(repo.fetch_remote("backup").unwrap().ok);
    assert!(!git(&mine, &["branch", "-r", "--list", "backup/main"]).is_empty());
    repo.rename_remote("backup", "mirror").unwrap();
    assert!(!git(&mine, &["branch", "-r", "--list", "mirror/main"]).is_empty());
    repo.set_remote_url("mirror", backup.to_str().unwrap(), "/elsewhere.git").unwrap();
    let mirror = repo.remote_details().unwrap().into_iter().find(|r| r.name == "mirror").unwrap();
    assert_eq!(mirror.push_url.as_deref(), Some("/elsewhere.git"));
    repo.set_remote_url("mirror", backup.to_str().unwrap(), "").unwrap();
    assert!(repo.remote_details().unwrap().into_iter().find(|r| r.name == "mirror").unwrap().push_url.is_none());
    repo.remove_remote("mirror").unwrap();
    assert_eq!(repo.remote_details().unwrap().len(), 1);
    assert!(repo.add_remote("-x", "y").is_err());

    // Push a tag, then delete it on the remote; the local tag stays.
    git(&mine, &["tag", "v1"]);
    repo.push_tag("origin", "v1").unwrap();
    assert!(!git(&origin, &["tag", "-l", "v1"]).is_empty());
    repo.delete_remote_ref("origin", "refs/tags/v1").unwrap();
    assert!(git(&origin, &["tag", "-l", "v1"]).is_empty());
    assert!(!git(&mine, &["tag", "-l", "v1"]).is_empty());

    // A pushed branch can be deleted on the remote.
    git(&mine, &["push", "-q", "origin", "main:refs/heads/topic"]);
    repo.delete_remote_ref("origin", "refs/heads/topic").unwrap();
    assert!(git(&origin, &["branch", "--list", "topic"]).is_empty());
    assert!(repo.delete_remote_ref("origin", "main").is_err());

    // Stop tracking, then track again.
    repo.set_upstream("main", None).unwrap();
    assert!(repo.push_info(None).unwrap().upstream.is_none());
    repo.set_upstream("main", Some("origin/main")).unwrap();
    assert_eq!(repo.push_info(None).unwrap().upstream.as_deref(), Some("origin/main"));
}

#[test]
fn compare_two_refs() {
    let (_origin, _seed, mine) = setup("compare");
    git(&mine, &["config", "commit.gpgsign", "false"]);
    let base = git(&mine, &["rev-parse", "HEAD"]);
    git(&mine, &["checkout", "-q", "-b", "topic"]);
    commit(&mine, "t1.txt", "1\n", "T1");
    commit(&mine, "t2.txt", "2\n", "T2");
    git(&mine, &["checkout", "-q", "main"]);
    commit(&mine, "m.txt", "m\n", "M1");
    let repo = Repo::open(&mine).unwrap();
    let c = repo.compare_refs("topic", "main").unwrap();
    assert_eq!(c.only_left.iter().map(|x| x.subject.as_str()).collect::<Vec<_>>(), ["T2", "T1"]);
    assert_eq!(c.only_right.iter().map(|x| x.subject.as_str()).collect::<Vec<_>>(), ["M1"]);
    assert_eq!(c.base.as_deref(), Some(base.as_str()));
    assert!(repo.compare_refs("topic", "no-such-branch").is_err());
    assert!(repo.compare_refs("-x", "main").is_err());
}
