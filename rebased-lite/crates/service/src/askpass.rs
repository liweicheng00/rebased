//! Prompts for passwords, SSH passphrases and host keys, as IntelliJ's askpass does.
//!
//! Git and ssh run the program in `GIT_ASKPASS` and `SSH_ASKPASS` with the prompt as the first argument,
//! and read the answer from its output. The app sets its own executable there. Started that way, the
//! executable sends the prompt to the running app through a Unix socket and prints the answer; see
//! [`run_helper_if_requested`]. The app keeps the prompt until the front end answers it.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

const SOCKET_ENV: &str = "REBASED_ASKPASS_SOCKET";
/// A prompt that nobody answers fails after this time, so git does not wait forever.
const TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Clone, Debug, Serialize)]
#[derive(ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Prompt {
    pub id: u64,
    pub text: String,
    /// A password or a passphrase: the field hides the input.
    pub secret: bool,
    /// A yes or no question, for example an unknown SSH host key.
    pub confirm: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    pub id: u64,
    /// None cancels the prompt.
    pub answer: Option<String>,
    /// Keep the answer for the same prompt until the app closes.
    #[serde(default)]
    pub remember: bool,
}

#[derive(Default)]
struct State {
    next: u64,
    pending: Vec<Prompt>,
    answers: HashMap<u64, Option<String>>,
    /// Answers kept for the session, by prompt text.
    cache: HashMap<String, String>,
}

/// Gets the prompts that wait for an answer, each time they change.
pub type OnPrompts = Arc<dyn Fn(Vec<Prompt>) + Send + Sync>;

pub struct Askpass {
    state: Mutex<State>,
    changed: Condvar,
    socket: PathBuf,
    on_prompts: Option<OnPrompts>,
}

impl Askpass {
    /// Starts the socket listener and makes git use `helper` for prompts.
    pub fn start(helper: &Path, on_prompts: Option<OnPrompts>) -> std::io::Result<Arc<Askpass>> {
        let socket = std::env::temp_dir().join(format!("rebased-lite-askpass-{}.sock", std::process::id()));
        let askpass = Arc::new(Askpass { state: Mutex::default(), changed: Condvar::new(), socket: socket.clone(), on_prompts });
        #[cfg(unix)]
        {
            let _ = std::fs::remove_file(&socket);
            let listener = std::os::unix::net::UnixListener::bind(&socket)?;
            let me = askpass.clone();
            std::thread::spawn(move || {
                for conn in listener.incoming().flatten() {
                    let me = me.clone();
                    std::thread::spawn(move || me.serve(conn));
                }
            });
        }
        let helper = helper.to_string_lossy().into_owned();
        rebased_git::set_network_env(vec![
            ("GIT_ASKPASS".into(), helper.clone()),
            ("SSH_ASKPASS".into(), helper),
            // OpenSSH 8.4 and newer: use the askpass program without a terminal or a display.
            ("SSH_ASKPASS_REQUIRE".into(), "force".into()),
            (SOCKET_ENV.into(), socket.to_string_lossy().into_owned()),
        ]);
        Ok(askpass)
    }

    #[cfg(unix)]
    fn serve(&self, conn: std::os::unix::net::UnixStream) {
        use std::io::{BufRead, BufReader, Write};
        let mut reader = BufReader::new(&conn);
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() {
            return;
        }
        let text = serde_json::from_str::<serde_json::Value>(&line).ok().and_then(|v| v["prompt"].as_str().map(String::from)).unwrap_or_default();
        let answer = self.ask(&text);
        let reply = serde_json::json!({ "answer": answer }).to_string();
        let mut w = &conn;
        let _ = w.write_all(reply.as_bytes());
        let _ = w.write_all(b"\n");
    }

    /// Waits for the front end to answer a prompt. None means cancelled.
    fn ask(&self, text: &str) -> Option<String> {
        let mut st = self.state.lock().unwrap();
        if let Some(a) = st.cache.get(text) {
            return Some(a.clone());
        }
        st.next += 1;
        let id = st.next;
        let lower = text.to_lowercase();
        st.pending.push(Prompt {
            id,
            text: text.to_string(),
            secret: ["password", "passphrase", "pin", "token"].iter().any(|w| lower.contains(w)),
            confirm: lower.contains("(yes/no"),
        });
        self.notify(&st);
        let (mut st, timeout) = self.changed.wait_timeout_while(st, TIMEOUT, |s| !s.answers.contains_key(&id)).unwrap();
        st.pending.retain(|p| p.id != id);
        self.notify(&st);
        if timeout.timed_out() {
            return None;
        }
        st.answers.remove(&id).flatten()
    }

    fn notify(&self, st: &State) {
        if let Some(f) = &self.on_prompts {
            f(st.pending.clone());
        }
    }

    pub fn pending(&self) -> Vec<Prompt> {
        self.state.lock().unwrap().pending.clone()
    }

    pub fn answer(&self, a: Answer) {
        let mut st = self.state.lock().unwrap();
        let Some(p) = st.pending.iter().find(|p| p.id == a.id).cloned() else { return };
        if let (true, Some(v)) = (a.remember, &a.answer) {
            st.cache.insert(p.text.clone(), v.clone());
        }
        st.answers.insert(a.id, a.answer);
        st.pending.retain(|x| x.id != a.id);
        self.notify(&st);
        self.changed.notify_all();
    }

    /// Forgets the answers kept for the session.
    pub fn forget(&self) {
        self.state.lock().unwrap().cache.clear();
    }
}

impl Drop for Askpass {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.socket);
    }
}

/// Call this first in `main`. When git or ssh started the executable as its askpass program, this sends
/// the prompt to the running app, prints the answer, and exits.
pub fn run_helper_if_requested() {
    let Some(socket) = std::env::var_os(SOCKET_ENV) else { return };
    let prompt = std::env::args().nth(1).unwrap_or_default();
    let code = match helper(Path::new(&socket), &prompt) {
        Some(answer) => {
            println!("{answer}");
            0
        }
        None => 1,
    };
    std::process::exit(code);
}

#[cfg(unix)]
fn helper(socket: &Path, prompt: &str) -> Option<String> {
    use std::io::{BufRead, BufReader, Write};
    let mut conn = std::os::unix::net::UnixStream::connect(socket).ok()?;
    let req = serde_json::json!({ "prompt": prompt }).to_string();
    conn.write_all(req.as_bytes()).ok()?;
    conn.write_all(b"\n").ok()?;
    let mut line = String::new();
    BufReader::new(&conn).read_line(&mut line).ok()?;
    serde_json::from_str::<serde_json::Value>(&line).ok()?["answer"].as_str().map(String::from)
}

#[cfg(not(unix))]
fn helper(_socket: &Path, _prompt: &str) -> Option<String> {
    None
}
