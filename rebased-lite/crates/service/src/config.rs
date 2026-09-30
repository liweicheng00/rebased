//! The settings that the backend needs before the front end starts: the git program and the Local
//! History limits. They are in `settings.json` in the configuration directory of the user:
//! `$XDG_CONFIG_HOME/rebased-lite` or `~/.config/rebased-lite` on Linux,
//! `~/Library/Application Support/rebased-lite` on macOS, and `%APPDATA%\rebased-lite` on Windows.
//! `REBASED_LITE_CONFIG_DIR` changes the directory, for tests.

use crate::history::Limits;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[derive(ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase", default)]
pub struct BackendSettings {
    /// The git program; empty means git from PATH.
    pub git_path: String,
    pub history: Limits,
    /// False until the settings were saved once. The front end then moves its old copy here.
    pub stored: bool,
}

/// The directory of the settings file, or None when the system gives no home directory.
pub fn config_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("REBASED_LITE_CONFIG_DIR") {
        return Some(PathBuf::from(d));
    }
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let base = if cfg!(target_os = "macos") {
        home?.join("Library").join("Application Support")
    } else if cfg!(windows) {
        PathBuf::from(std::env::var_os("APPDATA")?)
    } else {
        std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).or_else(|| home.map(|h| h.join(".config")))?
    };
    Some(base.join("rebased-lite"))
}

/// Reads the settings file. A missing or damaged file gives the defaults.
pub fn load(dir: &Option<PathBuf>) -> BackendSettings {
    let Some(dir) = dir else { return BackendSettings::default() };
    match std::fs::read(dir.join("settings.json")) {
        Ok(bytes) => {
            let mut s: BackendSettings = serde_json::from_slice(&bytes).unwrap_or_default();
            s.stored = true;
            s
        }
        Err(_) => BackendSettings::default(),
    }
}

/// Writes the settings file through a temporary file, so a crash never leaves half a file.
pub fn save(dir: &Option<PathBuf>, s: &BackendSettings) -> Result<(), String> {
    let Some(dir) = dir else { return Ok(()) };
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join("settings.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(s).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join("settings.json")).map_err(|e| e.to_string())
}
