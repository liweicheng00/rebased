//! Stashes: save local changes away and apply them later, as in IntelliJ's Stash tab.

use crate::ops::{safe, OpResult};
use crate::{parse_name_status, Change, GitError, Repo, Result};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stash {
    pub index: usize,
    pub oid: String,
    /// The message without the "On <branch>:" prefix.
    pub message: String,
    pub branch: Option<String>,
    pub time: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashDetail {
    pub oid: String,
    /// The commit the stash was made on.
    pub base: String,
    /// The commit with the untracked files, if the stash has them.
    pub untracked_oid: Option<String>,
    /// Tracked changes from `base` to the stash.
    pub changes: Vec<Change>,
    /// Untracked files; their content is in `untracked_oid`.
    pub untracked: Vec<String>,
}

fn text(b: Vec<u8>) -> String {
    String::from_utf8_lossy(&b).trim().to_string()
}

fn stash_ref(index: usize) -> String {
    format!("stash@{{{index}}}")
}

/// Splits "On main: message" or "WIP on main: abc1234 subject" into the branch and the message.
fn parse_subject(s: &str) -> (Option<String>, String) {
    for prefix in ["WIP on ", "On "] {
        if let Some(rest) = s.strip_prefix(prefix) {
            if let Some((branch, msg)) = rest.split_once(": ") {
                return (Some(branch.to_string()), msg.to_string());
            }
        }
    }
    (None, s.to_string())
}

impl Repo {
    pub fn stashes(&self) -> Result<Vec<Stash>> {
        let raw = match self.git(&["stash", "list", "--format=%H%x1f%gs%x1f%ct"]) {
            Ok(r) => r,
            Err(_) => return Ok(Vec::new()),
        };
        Ok(text(raw)
            .lines()
            .enumerate()
            .filter_map(|(index, l)| {
                let mut p = l.split('\x1f');
                let oid = p.next()?.to_string();
                let (branch, message) = parse_subject(p.next()?);
                Some(Stash { index, oid, message, branch, time: p.next()?.parse().ok()? })
            })
            .collect())
    }

    fn stash_oid(&self, index: usize) -> Result<String> {
        self.resolve(&stash_ref(index)).ok_or_else(|| GitError(format!("There is no stash {}", stash_ref(index))))
    }

    pub fn stash_detail(&self, index: usize) -> Result<StashDetail> {
        let oid = self.stash_oid(index)?;
        let base = text(self.git(&["rev-parse", &format!("{oid}^1")])?);
        let untracked_oid = self.git(&["rev-parse", "-q", "--verify", &format!("{oid}^3")]).ok().map(text).filter(|s| !s.is_empty());
        let mut changes = parse_name_status(&self.git(&["diff", "--name-status", "-M", "-z", &base, &oid])?);
        changes.sort_by(|a, b| a.path.cmp(&b.path));
        let untracked = match &untracked_oid {
            Some(u) => {
                let raw = self.git(&["ls-tree", "-r", "-z", "--name-only", u])?;
                raw.split(|&b| b == 0).filter(|p| !p.is_empty()).map(|p| String::from_utf8_lossy(p).into_owned()).collect()
            }
            None => Vec::new(),
        };
        Ok(StashDetail { oid, base, untracked_oid, changes, untracked })
    }

    /// Stashes local changes. With paths, only those files; untracked paths are included.
    pub fn stash_push(&self, message: &str, paths: &[String], include_untracked: bool, keep_index: bool) -> Result<OpResult> {
        let mut args = vec!["stash", "push"];
        if include_untracked {
            args.push("--include-untracked");
        }
        if keep_index {
            args.push("--keep-index");
        }
        if !message.trim().is_empty() {
            args.extend(["-m", message.trim()]);
        }
        if !paths.is_empty() {
            args.push("--");
            args.extend(paths.iter().map(String::as_str));
        }
        let out = self.git_write(&args, &[]).map_err(|(_, e)| GitError(e))?;
        if out.contains("No local changes to save") {
            return Err(GitError("There are no local changes to stash".into()));
        }
        Ok(OpResult::ok_msg(if paths.is_empty() { "Stashed the local changes".to_string() } else { format!("Stashed {} file(s)", paths.len()) }))
    }

    /// Applies a stash. `pop` drops it when it applies without conflicts. `index` restores the staged state too.
    pub fn stash_apply(&self, index: usize, pop: bool, restore_index: bool) -> Result<OpResult> {
        self.stash_oid(index)?;
        let r = stash_ref(index);
        let mut args = vec!["stash", if pop { "pop" } else { "apply" }];
        if restore_index {
            args.push("--index");
        }
        args.push(&r);
        match self.git_write(&args, &[]) {
            Ok(_) => Ok(OpResult::ok_msg(if pop { format!("Applied and dropped {r}") } else { format!("Applied {r}") })),
            Err((out, e)) => {
                let conflicts = self.conflicts();
                if conflicts.is_empty() {
                    Err(GitError(if out.is_empty() { e } else { format!("{e}\n{out}") }))
                } else {
                    Ok(OpResult {
                        ok: false,
                        message: format!(
                            "The stash applied with conflicts in {} file(s). Resolve them and mark them resolved.{}",
                            conflicts.len(),
                            if pop { " The stash was kept." } else { "" }
                        ),
                        conflicts,
                        undo_to: None,
                        undo_soft: false,
                    })
                }
            }
        }
    }

    pub fn stash_drop(&self, index: usize) -> Result<OpResult> {
        let oid = self.stash_oid(index)?;
        let r = stash_ref(index);
        self.git_write(&["stash", "drop", &r], &[]).map_err(|(_, e)| GitError(e))?;
        Ok(OpResult::ok_msg(format!("Dropped {r} ({})", &oid[..8])))
    }

    /// Creates a branch at the commit of the stash, checks it out, and applies the stash there.
    pub fn stash_branch(&self, index: usize, branch: &str) -> Result<OpResult> {
        self.stash_oid(index)?;
        let r = stash_ref(index);
        self.git_write(&["stash", "branch", safe(branch)?, &r], &[]).map_err(|(_, e)| GitError(e))?;
        Ok(OpResult::ok_msg(format!("Created {branch} from {r}")))
    }
}

#[cfg(test)]
mod tests {
    use super::parse_subject;

    #[test]
    fn subjects() {
        assert_eq!(parse_subject("On main: my work"), (Some("main".into()), "my work".into()));
        assert_eq!(parse_subject("WIP on feature/x: abc1234 Fix"), (Some("feature/x".into()), "abc1234 Fix".into()));
        assert_eq!(parse_subject("odd"), (None, "odd".into()));
    }
}
