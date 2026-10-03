//! Tag details, the tags of a remote, and Push All Tags.

use rebased_git::Repo;
use std::path::Path;
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

#[test]
fn tags() {
    let base = std::env::temp_dir().join(format!("rebased-lite-tags-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    let origin = base.join("origin.git");
    git(&base, &["init", "-q", "--bare", origin.to_str().unwrap()]);
    let dir = base.join("mine");
    git(&base, &["clone", "-q", origin.to_str().unwrap(), dir.to_str().unwrap()]);
    git(&dir, &["config", "user.name", "Me"]);
    git(&dir, &["config", "user.email", "me@example.com"]);
    git(&dir, &["commit", "-q", "--allow-empty", "-m", "First"]);
    let head = git(&dir, &["rev-parse", "HEAD"]);
    git(&dir, &["tag", "-a", "v1.0.0", "-m", "Release 1.0\n\nThe first release."]);
    git(&dir, &["tag", "light"]);
    let repo = Repo::open(&dir).unwrap();

    let t = repo.tag_info("v1.0.0").unwrap();
    assert!(t.annotated && !t.signed);
    assert_eq!((t.commit.as_str(), t.subject.as_str(), t.body.as_str()), (head.as_str(), "Release 1.0", "The first release."));
    assert_eq!((t.tagger.as_str(), t.tagger_email.as_str()), ("Me", "me@example.com"));
    assert!(t.time > 0);
    let l = repo.tag_info("light").unwrap();
    assert!(!l.annotated && l.subject.is_empty() && l.commit == head);
    assert!(repo.tag_info("nope").is_err());

    // The remote has no tags; Push All Tags sends both.
    assert!(repo.remote_tags("origin").unwrap().is_empty());
    let r = repo.push_all_tags("origin").unwrap();
    assert!(r.ok, "{}", r.message);
    let mut on_remote = repo.remote_tags("origin").unwrap();
    on_remote.sort();
    assert_eq!(on_remote, ["light", "v1.0.0"]);
}
