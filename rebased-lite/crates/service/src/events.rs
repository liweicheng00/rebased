//! Events that the backend pushes to the front end: a repository changed outside the app, or git asks
//! for a password. The Tauri app sends them as window events, the dev server as server-sent events.

use crate::askpass::Prompt;
use serde::Serialize;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;

#[derive(Clone, Debug, Serialize)]
#[derive(ts_rs::TS)]
#[ts(export)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Event {
    /// The watcher counters of a repository went up; see `watch_state`.
    Watch { root: String, repo: u64, files: u64 },
    /// The prompts that wait for an answer changed.
    Askpass { prompts: Vec<Prompt> },
}

/// The subscribers. A subscriber that went away is removed at the next event.
#[derive(Default)]
pub struct Events {
    subs: Mutex<Vec<Sender<Event>>>,
}

impl Events {
    pub fn subscribe(&self) -> Receiver<Event> {
        let (tx, rx) = channel();
        self.subs.lock().unwrap().push(tx);
        rx
    }

    pub fn emit(&self, e: Event) {
        self.subs.lock().unwrap().retain(|s| s.send(e.clone()).is_ok());
    }
}
