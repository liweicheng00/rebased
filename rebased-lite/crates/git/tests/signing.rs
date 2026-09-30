//! Commits that the app writes with git commit-tree get a signature when commit.gpgsign is on, and a
//! partial commit runs the commit hooks. The test uses a GPG key without a passphrase in its own GNUPGHOME.

use rebased_git::changelist::PartialFile;
use rebased_git::ops::{Action, PlanEntry};
use rebased_git::Repo;
use std::path::Path;
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn commit(dir: &Path, file: &str, text: &str, msg: &str) -> String {
    std::fs::write(dir.join(file), text).unwrap();
    git(dir, &["add", file]);
    git(dir, &["commit", "-q", "-m", msg]);
    git(dir, &["rev-parse", "HEAD"])
}

#[test]
fn rewrites_and_partial_commits_are_signed_and_run_hooks() {
    let base = std::env::temp_dir().join(format!("rebased-lite-sign-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let gnupg = base.join("gnupg");
    std::fs::create_dir_all(&gnupg).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&gnupg, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    // Only this test binary changes the environment, and it has no other test. The global and system git
    // config of the machine may sign in another way; the repository config decides here.
    std::env::set_var("GNUPGHOME", &gnupg);
    std::env::set_var("GIT_CONFIG_GLOBAL", "/dev/null");
    std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
    let out = Command::new("gpg")
        .args(["--batch", "--pinentry-mode", "loopback", "--passphrase", "", "--quick-gen-key", "Test <test@example.com>", "ed25519", "sign", "never"])
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));

    let dir = base.join("repo");
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "-b", "main"]);
    git(&dir, &["config", "user.name", "Test"]);
    git(&dir, &["config", "user.email", "test@example.com"]);
    git(&dir, &["config", "user.signingkey", "test@example.com"]);
    git(&dir, &["config", "commit.gpgsign", "true"]);
    let a = commit(&dir, "a.txt", "a\n", "A");
    let b = commit(&dir, "b.txt", "b\n", "B");
    let c = commit(&dir, "c.txt", "c\n", "C");
    let repo = Repo::open(&dir).unwrap();

    // An in-memory squash writes new commits with commit-tree; they are signed.
    let plan = vec![
        PlanEntry { oid: b.clone(), action: Action::Pick, message: Some("B and C".into()), author: None },
        PlanEntry { oid: c.clone(), action: Action::Squash, message: Some("B and C".into()), author: None },
    ];
    assert!(repo.rewrite(&a, &plan, "Squash").unwrap().ok);
    assert_eq!(git(&dir, &["log", "-1", "--format=%s"]), "B and C");
    assert!(git(&dir, &["cat-file", "commit", "HEAD"]).contains("-----BEGIN PGP SIGNATURE-----"));
    assert_eq!(git(&dir, &["log", "-1", "--format=%G?"]), "G");

    // A partial commit runs pre-commit with the content of the commit, and commit-msg.
    let hooks = dir.join(".git/hooks");
    std::fs::write(
        hooks.join("pre-commit"),
        "#!/bin/sh\nif git diff --cached | grep -q FORBIDDEN; then echo 'FORBIDDEN is not allowed' >&2; exit 1; fi\n",
    )
    .unwrap();
    std::fs::write(hooks.join("commit-msg"), "#!/bin/sh\nprintf '\\nHook-Checked: yes\\n' >> \"$1\"\n").unwrap();
    #[cfg(unix)]
    for h in ["pre-commit", "commit-msg"] {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(hooks.join(h), std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    std::fs::write(dir.join("a.txt"), "a\nFORBIDDEN\nok\n").unwrap();
    let head = git(&dir, &["rev-parse", "HEAD"]);
    let err = repo
        .commit_partial(&[], &[], &[PartialFile { path: "a.txt".into(), content: "a\nFORBIDDEN\n".into() }], "Bad", false)
        .unwrap_err();
    assert!(err.0.contains("pre-commit") && err.0.contains("FORBIDDEN is not allowed"), "{}", err.0);
    assert_eq!(git(&dir, &["rev-parse", "HEAD"]), head, "a failed hook commits nothing");

    // Only the allowed part goes in: the hook sees the content of the commit, not the working tree.
    let r = repo.commit_partial(&[], &[], &[PartialFile { path: "a.txt".into(), content: "a\nok\n".into() }], "Good part", false).unwrap();
    assert!(r.ok, "{}", r.message);
    assert_eq!(git(&dir, &["log", "-1", "--format=%B"]), "Good part\n\nHook-Checked: yes");
    assert_eq!(git(&dir, &["log", "-1", "--format=%G?"]), "G");
}
