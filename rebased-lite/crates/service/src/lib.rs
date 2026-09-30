//! App state and commands. Every command takes and returns JSON-serializable values.
//!
//! The modules: `types` has the arguments and results of the commands, `session` the open repositories,
//! `view` the graph rows, `queries` the read commands, `ops` the write operations, and `dispatch` the
//! table of commands by name.

pub mod askpass;
pub mod config;
mod dispatch;
pub mod history;
mod ops;
mod queries;
mod session;
mod types;
mod view;
pub mod watch;

pub use ops::{HunkSelection, Op};
pub use types::*;

pub use rebased_git::changelist::{ChangeListOp, LocalChanges, PartialFile};
use std::sync::Mutex;

pub type Result<T> = std::result::Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[derive(Default)]
pub struct Service {
    session: Mutex<session::Sessions>,
    askpass: Option<std::sync::Arc<askpass::Askpass>>,
    /// The directory of settings.json; None keeps the settings in memory only, as in tests.
    config_dir: Option<std::path::PathBuf>,
    settings: Mutex<config::BackendSettings>,
}
