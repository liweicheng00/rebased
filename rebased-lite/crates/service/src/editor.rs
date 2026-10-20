//! Open in Editor: opens a file of the working tree at a line in the editor of the user.
//!
//! The settings keep the editor as a command, for example `code --goto {file}:{line}:{column}`. The
//! command runs without a shell, so a file name cannot add arguments or commands. An empty command opens
//! the file with the default app of the system, without a line.
//!
//! An app that starts from the Finder or the Dock on macOS gets a short PATH without Homebrew and the
//! command-line launchers of the editors. So the search for the program also uses the PATH of the login
//! shell of the user and the usual folders of these launchers.

use crate::{EditorArgs, Result, Service};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

/// Splits a command into words. Single and double quotes keep spaces in a word, and a backslash keeps
/// the next character.
pub fn split_command(s: &str) -> Result<Vec<String>> {
    let mut words = Vec::new();
    let mut cur = String::new();
    let mut in_word = false;
    let mut quote: Option<char> = None;
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some('"'), '\\') | (None, '\\') => {
                cur.push(chars.next().unwrap_or('\\'));
                in_word = true;
            }
            (Some(_), c) => cur.push(c),
            (None, '"' | '\'') => {
                quote = Some(c);
                in_word = true;
            }
            (None, c) if c.is_whitespace() => {
                if in_word {
                    words.push(std::mem::take(&mut cur));
                    in_word = false;
                }
            }
            (None, c) => {
                cur.push(c);
                in_word = true;
            }
        }
    }
    if quote.is_some() {
        return Err("The editor command has a quote without its end".into());
    }
    if in_word {
        words.push(cur);
    }
    Ok(words)
}

/// The program and its arguments for a file and a line. `{file}`, `{line}` and `{column}` in the
/// command change to their values. A command without `{file}` gets the file as its last argument.
pub fn editor_command(template: &str, file: &Path, line: u32, column: u32) -> Result<(String, Vec<String>)> {
    let file = file.to_string_lossy();
    let words = split_command(template)?;
    let Some((program, rest)) = words.split_first() else {
        return Ok(system_open(&file));
    };
    let fill = |w: &str| w.replace("{file}", &file).replace("{line}", &line.to_string()).replace("{column}", &column.to_string());
    let mut args: Vec<String> = rest.iter().map(|w| fill(w)).collect();
    if !template.contains("{file}") {
        args.push(file.to_string());
    }
    Ok((fill(program), args))
}

/// The default app of the system for a file.
fn system_open(file: &str) -> (String, Vec<String>) {
    if cfg!(target_os = "macos") {
        ("open".into(), vec![file.into()])
    } else if cfg!(windows) {
        ("rundll32".into(), vec!["url.dll,FileProtocolHandler".into(), file.into()])
    } else {
        ("xdg-open".into(), vec![file.into()])
    }
}

/// A path of the working tree, relative to the root, without `..`.
pub fn working_tree_file(root: &Path, path: &str) -> Result<PathBuf> {
    let rel = Path::new(path);
    if path.is_empty() || !rel.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(format!("{path} is not a path in the repository"));
    }
    let full = root.join(rel);
    if !full.exists() {
        return Err(format!("{path} is not in the working tree"));
    }
    Ok(full)
}

/// The PATH of the login shell of the user, read once.
pub(crate) fn login_path() -> &'static Option<String> {
    static PATH: OnceLock<Option<String>> = OnceLock::new();
    PATH.get_or_init(|| {
        if cfg!(windows) {
            return None;
        }
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let out = Command::new(shell).args(["-l", "-c", "printf %s \"$PATH\""]).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    })
}

/// The folders where Rebased Lite looks for the program of the editor.
fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for p in [std::env::var("PATH").ok(), login_path().clone()].into_iter().flatten() {
        dirs.extend(std::env::split_paths(&p));
    }
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join("Library/Application Support/JetBrains/Toolbox/scripts"));
        dirs.push(home.join(".local/share/JetBrains/Toolbox/scripts"));
    }
    for d in ["/opt/homebrew/bin", "/usr/local/bin", "/Applications/Visual Studio Code.app/Contents/Resources/app/bin", "/Applications/Cursor.app/Contents/Resources/app/bin"] {
        dirs.push(PathBuf::from(d));
    }
    dirs
}

/// The full path of a program, or the name as it is when it has a folder in it.
fn find_program(name: &str) -> Option<PathBuf> {
    if name.contains('/') || name.contains('\\') {
        return Some(PathBuf::from(name));
    }
    let exts: &[&str] = if cfg!(windows) { &["exe", "cmd", "bat"] } else { &[""] };
    for d in search_dirs() {
        for ext in exts {
            let p = if ext.is_empty() { d.join(name) } else { d.join(format!("{name}.{ext}")) };
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

impl Service {
    /// Opens a file of the working tree at a line in the editor of the settings.
    pub fn open_in_editor(&self, args: EditorArgs) -> Result<()> {
        let root = self.with_repo(|r| Ok(r.root.clone()))?;
        let file = working_tree_file(&root, &args.path)?;
        let template = self.settings.lock().unwrap().editor.clone();
        let (program, list) = editor_command(&template, &file, args.line.max(1), args.column.max(1))?;
        let exe = find_program(&program).ok_or_else(|| format!("Cannot find the editor program {program}. Set its full path in Settings › Editor"))?;
        let mut child = Command::new(exe)
            .args(&list)
            .current_dir(&root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Cannot start {program}: {e}"))?;
        // The launcher of most editors exits soon. The wait frees its process entry.
        std::thread::spawn(move || child.wait());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_keeps_quoted_words() {
        assert_eq!(split_command(r#"code --goto "{file}:{line}""#).unwrap(), ["code", "--goto", "{file}:{line}"]);
        assert_eq!(split_command(r"'/Applications/My Editor' -n \{x\}").unwrap(), ["/Applications/My Editor", "-n", "{x}"]);
        assert_eq!(split_command("  a   b ").unwrap(), ["a", "b"]);
        assert!(split_command("code \"x").is_err());
    }

    #[test]
    fn fills_the_file_and_the_line() {
        let f = Path::new("/r/a b.rs");
        let (p, a) = editor_command("code --goto {file}:{line}:{column}", f, 12, 3).unwrap();
        assert_eq!((p.as_str(), a), ("code", vec!["--goto".to_string(), "/r/a b.rs:12:3".into()]));
        let (p, a) = editor_command("idea --line {line}", f, 7, 1).unwrap();
        assert_eq!((p.as_str(), a), ("idea", vec!["--line".to_string(), "7".into(), "/r/a b.rs".into()]));
        // A file name with a semicolon stays one argument: no shell runs the command.
        let (_, a) = editor_command("subl {file}:{line}", Path::new("/r/x;rm -rf y"), 1, 1).unwrap();
        assert_eq!(a, ["/r/x;rm -rf y:1"]);
        let (p, a) = editor_command("", f, 1, 1).unwrap();
        assert!(!p.is_empty() && a.last().unwrap() == "/r/a b.rs");
    }

    #[test]
    fn the_path_stays_in_the_repository() {
        let root = std::env::temp_dir().join(format!("rebased-lite-editor-{}", std::process::id()));
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/a.rs"), "").unwrap();
        assert_eq!(working_tree_file(&root, "src/a.rs").unwrap(), root.join("src/a.rs"));
        for bad in ["../etc/passwd", "/etc/passwd", "src/../../x", ""] {
            assert!(working_tree_file(&root, bad).is_err(), "{bad}");
        }
        assert!(working_tree_file(&root, "src/gone.rs").unwrap_err().contains("not in the working tree"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
