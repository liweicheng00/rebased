//! Git asks for a user name and a password through the askpass program of the app. `git credential fill`
//! asks the same way as a fetch or a push, without a network.

use rebased_service::askpass::Answer;
use rebased_service::Service;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn fill(host: &str) -> std::thread::JoinHandle<(bool, String)> {
    let host = host.to_string();
    std::thread::spawn(move || {
        let mut child = Command::new("git")
            .args(["credential", "fill"])
            .envs(rebased_git::network_env())
            .env("GIT_TERMINAL_PROMPT", "0")
            // No credential helper of the user may answer.
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(format!("protocol=https\nhost={host}\n\n").as_bytes()).unwrap();
        let out = child.wait_with_output().unwrap();
        (out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned())
    })
}

/// Waits for the next prompt of the service.
fn next_prompt(s: &Service) -> rebased_service::askpass::Prompt {
    let end = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(p) = s.askpass_pending().into_iter().next() {
            return p;
        }
        assert!(Instant::now() < end, "no prompt came");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn prompts_answers_cache_and_cancel() {
    let s = Service::with_askpass(Path::new(env!("CARGO_BIN_EXE_rebased-devserver")));

    let job = fill("example.com");
    let user = next_prompt(&s);
    assert!(user.text.starts_with("Username for 'https://example.com'"), "{}", user.text);
    assert!(!user.secret && !user.confirm);
    s.askpass_answer(Answer { id: user.id, answer: Some("ada".into()), remember: false });
    let pass = next_prompt(&s);
    assert!(pass.text.starts_with("Password for 'https://ada@example.com'"), "{}", pass.text);
    assert!(pass.secret);
    s.askpass_answer(Answer { id: pass.id, answer: Some("s3cret".into()), remember: true });
    let (ok, out) = job.join().unwrap();
    assert!(ok);
    assert!(out.contains("username=ada") && out.contains("password=s3cret"), "{out}");

    // The remembered password comes from the cache; only the user name is asked again.
    let job = fill("example.com");
    let user = next_prompt(&s);
    s.askpass_answer(Answer { id: user.id, answer: Some("ada".into()), remember: false });
    let (ok, out) = job.join().unwrap();
    assert!(ok && out.contains("password=s3cret"), "{out}");
    assert!(s.askpass_pending().is_empty());

    // Cancel makes git fail.
    let job = fill("other.example.com");
    let user = next_prompt(&s);
    s.askpass_answer(Answer { id: user.id, answer: None, remember: false });
    let (ok, _) = job.join().unwrap();
    assert!(!ok);
}
