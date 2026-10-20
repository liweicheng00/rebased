//! The automatic choice of the git program: a program that does not work, as the stub of macOS while the
//! Xcode license is not accepted, is skipped, and the next one that works is used.

#![cfg(unix)]

use rebased_git::{choose_git_program, git_program, set_git_program};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

fn script(dir: &Path, name: &str, body: &str) -> String {
    let p = dir.join(name);
    std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    p.to_string_lossy().into_owned()
}

#[test]
fn skips_a_git_that_does_not_work() {
    let dir = std::env::temp_dir().join(format!("rebased-lite-gitchoice-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let stub = script(&dir, "stub-git", "echo \"You have not agreed to the Xcode license agreements. Please run 'sudo xcodebuild -license'\" >&2; exit 69");
    let real = script(&dir, "real-git", "echo 'git version 9.9.9'");
    let missing = dir.join("missing-git").to_string_lossy().into_owned();

    let choice = choose_git_program(&[stub.clone(), missing, real.clone()]).unwrap();
    assert_eq!(choice.program, real);
    assert_eq!(choice.version, "9.9.9");
    assert!(choice.skipped.as_deref().unwrap_or("").contains("Xcode license"), "{:?}", choice.skipped);
    assert_eq!(git_program(), real, "the chosen program is in use");

    let err = choose_git_program(&[stub]).unwrap_err();
    assert!(err.to_string().contains("does not work"), "{err}");

    set_git_program("").unwrap();
    let _ = std::fs::remove_dir_all(&dir);
}
