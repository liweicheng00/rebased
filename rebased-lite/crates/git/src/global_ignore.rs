//! The global ignore file: the patterns that git applies in all repositories of the user. Git reads the
//! file that `core.excludesFile` names. Without that setting, git reads `$XDG_CONFIG_HOME/git/ignore`,
//! or `~/.config/git/ignore`.

use crate::{git_command, GitError, Repo, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// The global ignore file and its text.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[derive(ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GlobalIgnore {
    /// The full path of the file.
    pub path: String,
    /// True when `core.excludesFile` names the file. False for the default file.
    pub configured: bool,
    /// False when the file does not exist yet. A save makes it.
    pub exists: bool,
    pub text: String,
}

/// The pattern that decides about a path, from `git check-ignore -v`.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[derive(ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct IgnoreMatch {
    /// True when git ignores the path. A negative pattern (`!name`) matches but does not ignore.
    pub ignored: bool,
    /// The file of the pattern, as git names it.
    pub source: String,
    pub line: u32,
    pub pattern: String,
}

/// The default file: `$XDG_CONFIG_HOME/git/ignore`, or `$HOME/.config/git/ignore`.
fn default_path() -> Result<PathBuf> {
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(xdg).join("git").join("ignore"));
    }
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).filter(|v| !v.is_empty());
    let home = home.ok_or_else(|| GitError("The home folder is not known: HOME is not set".into()))?;
    Ok(PathBuf::from(home).join(".config").join("git").join("ignore"))
}

/// The value of `core.excludesFile` in the global or the system configuration, with `~` expanded.
fn configured_path() -> Result<Option<PathBuf>> {
    for scope in ["--global", "--system"] {
        let out = git_command()
            .args(["config", scope, "--type=path", "--get", "core.excludesFile"])
            .current_dir(std::env::temp_dir())
            .output()
            .map_err(|e| GitError(format!("cannot run git: {e}")))?;
        let value = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if out.status.success() && !value.is_empty() {
            return Ok(Some(PathBuf::from(value)));
        }
    }
    Ok(None)
}

/// Finds the global ignore file and reads it.
pub fn global_ignore() -> Result<GlobalIgnore> {
    let configured = configured_path()?;
    let path = match &configured {
        Some(p) => p.clone(),
        None => default_path()?,
    };
    read(&path, configured.is_some())
}

fn read(path: &Path, configured: bool) -> Result<GlobalIgnore> {
    let (exists, text) = match std::fs::read(path) {
        Ok(bytes) => (true, String::from_utf8_lossy(&bytes).into_owned()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (false, String::new()),
        Err(e) => return Err(GitError(format!("cannot read {}: {e}", path.display()))),
    };
    Ok(GlobalIgnore { path: path.to_string_lossy().into_owned(), configured, exists, text })
}

/// Writes the global ignore file and makes its folder when necessary. `expected` is the text that the
/// caller read before. When the file changed since then, nothing is written and the result is an error.
pub fn save_global_ignore(text: &str, expected: &str) -> Result<GlobalIgnore> {
    let now = global_ignore()?;
    if now.text != expected {
        return Err(GitError("The file changed outside Rebased Lite. Reload it, then make your changes again".into()));
    }
    let path = PathBuf::from(&now.path);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| GitError(format!("cannot make {}: {e}", dir.display())))?;
    }
    let mut text = text.to_string();
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    std::fs::write(&path, &text).map_err(|e| GitError(format!("cannot write {}: {e}", path.display())))?;
    read(&path, now.configured)
}

impl Repo {
    /// The pattern that decides about `path` in this repository: from a .gitignore, `.git/info/exclude`
    /// or the global ignore file. `None` when no pattern matches. Git checks the path also when it tracks
    /// the file.
    pub fn check_ignore(&self, path: &str) -> Result<Option<IgnoreMatch>> {
        let path = path.trim();
        if path.is_empty() {
            return Err(GitError("Enter a path".into()));
        }
        let out = git_command()
            .current_dir(&self.root)
            .args(["check-ignore", "-v", "-n", "--no-index", "--"])
            .arg(path)
            .output()
            .map_err(|e| GitError(format!("cannot run git: {e}")))?;
        if out.status.code() == Some(128) {
            return Err(GitError(String::from_utf8_lossy(&out.stderr).trim().to_string()));
        }
        Ok(parse_check_ignore(&String::from_utf8_lossy(&out.stdout)))
    }
}

/// Reads one line of `git check-ignore -v -n`: "source:line:pattern<TAB>path". The line for a path
/// without a match is "::<TAB>path".
fn parse_check_ignore(out: &str) -> Option<IgnoreMatch> {
    let info = out.lines().next()?.split('\t').next()?;
    // The source can hold a colon (C:\ on Windows), and the pattern can too. The line number is the
    // first field between two colons that is a number.
    let colons: Vec<usize> = info.match_indices(':').map(|(i, _)| i).collect();
    let (start, end) = colons.windows(2).map(|w| (w[0], w[1])).find(|&(a, b)| info[a + 1..b].parse::<u32>().is_ok())?;
    let source = &info[..start];
    if source.is_empty() {
        return None;
    }
    let pattern = &info[end + 1..];
    Some(IgnoreMatch { ignored: !pattern.starts_with('!'), source: source.to_string(), line: info[start + 1..end].parse().ok()?, pattern: pattern.to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_check_ignore() {
        assert_eq!(parse_check_ignore("::\tsrc/a.rs\n"), None);
        assert_eq!(
            parse_check_ignore("/home/u/.config/git/ignore:2:.idea/\t.idea/x.xml\n"),
            Some(IgnoreMatch { ignored: true, source: "/home/u/.config/git/ignore".into(), line: 2, pattern: ".idea/".into() })
        );
        assert_eq!(
            parse_check_ignore(".gitignore:5:!keep.log\tkeep.log\n"),
            Some(IgnoreMatch { ignored: false, source: ".gitignore".into(), line: 5, pattern: "!keep.log".into() })
        );
        assert_eq!(
            parse_check_ignore("C:\\Users\\u\\ignore:3:*.tmp:x\ta.tmp:x\n"),
            Some(IgnoreMatch { ignored: true, source: "C:\\Users\\u\\ignore".into(), line: 3, pattern: "*.tmp:x".into() })
        );
    }
}
