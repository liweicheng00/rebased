//! Worktrees and recently used branches.

use crate::{GitError, Repo, Result};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[derive(ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub detached: bool,
    pub bare: bool,
    pub locked: bool,
    pub prunable: bool,
    /// The worktree that this repository window shows.
    pub current: bool,
    pub main: bool,
}

#[derive(Debug, Serialize)]
#[derive(ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct RecentBranch {
    pub name: String,
    pub oid: String,
    pub subject: String,
    /// When HEAD last moved to the branch, in seconds.
    pub time: i64,
}

impl Repo {
    pub fn worktrees(&self) -> Result<Vec<Worktree>> {
        let raw = self.git(&["worktree", "list", "--porcelain"])?;
        let text = String::from_utf8_lossy(&raw);
        let here = std::fs::canonicalize(&self.root).unwrap_or_else(|_| self.root.clone());
        let mut out = Vec::new();
        for block in text.split("\n\n").filter(|b| !b.trim().is_empty()) {
            let mut w = Worktree {
                path: String::new(),
                head: None,
                branch: None,
                detached: false,
                bare: false,
                locked: false,
                prunable: false,
                current: false,
                main: out.is_empty(),
            };
            for line in block.lines() {
                let (key, value) = line.split_once(' ').unwrap_or((line, ""));
                match key {
                    "worktree" => w.path = value.to_string(),
                    "HEAD" => w.head = Some(value.to_string()),
                    "branch" => w.branch = Some(value.trim_start_matches("refs/heads/").to_string()),
                    "detached" => w.detached = true,
                    "bare" => w.bare = true,
                    "locked" => w.locked = true,
                    "prunable" => w.prunable = true,
                    _ => {}
                }
            }
            w.current = std::fs::canonicalize(&w.path).map(|p| p == here).unwrap_or(false);
            out.push(w);
        }
        Ok(out)
    }

    /// Adds a worktree at `path`. With `new_branch`, it creates `branch` at `at`; otherwise it checks out
    /// the existing branch `branch`, or detaches at `at` when `branch` is empty.
    pub fn add_worktree(&self, path: &str, branch: &str, new_branch: bool, at: &str) -> Result<()> {
        if path.trim().is_empty() || path.starts_with('-') {
            return Err(GitError("Choose a folder for the worktree".into()));
        }
        let mut args = vec!["worktree", "add"];
        if new_branch {
            if branch.is_empty() || branch.starts_with('-') {
                return Err(GitError("Enter a name for the new branch".into()));
            }
            args.extend(["-b", branch, "--", path]);
            if !at.is_empty() {
                args.push(at);
            }
        } else if branch.is_empty() {
            args.extend(["--detach", "--", path]);
            if !at.is_empty() {
                args.push(at);
            }
        } else {
            args.extend(["--", path, branch]);
        }
        self.git(&args).map(|_| ())
    }

    pub fn remove_worktree(&self, path: &str, force: bool) -> Result<()> {
        let mut args = vec!["worktree", "remove"];
        if force {
            args.push("--force");
        }
        args.extend(["--", path]);
        self.git(&args).map(|_| ())
    }

    pub fn prune_worktrees(&self) -> Result<()> {
        self.git(&["worktree", "prune"]).map(|_| ())
    }

    /// Local branches that HEAD moved to most recently (from the HEAD reflog), newest first. The current
    /// branch is left out.
    pub fn recent_branches(&self, limit: usize) -> Result<Vec<RecentBranch>> {
        let raw = self.git(&["reflog", "show", "--format=%gs%x00%ct", "-n", "1000", "HEAD", "--"]).unwrap_or_default();
        let current = self.git(&["symbolic-ref", "-q", "--short", "HEAD"]).ok().map(|b| String::from_utf8_lossy(&b).trim().to_string());
        let mut names: Vec<(String, i64)> = Vec::new();
        for line in String::from_utf8_lossy(&raw).lines() {
            let (subject, time) = line.split_once('\0').unwrap_or((line, "0"));
            let Some(rest) = subject.strip_prefix("checkout: moving from ") else { continue };
            let Some((_, to)) = rest.rsplit_once(" to ") else { continue };
            if Some(to) == current.as_deref() || names.iter().any(|(n, _)| n == to) {
                continue;
            }
            names.push((to.to_string(), time.parse().unwrap_or(0)));
        }
        let mut out = Vec::new();
        for (name, time) in names {
            if out.len() >= limit {
                break;
            }
            // Keep only names that are still local branches (a reflog line can name a commit or a deleted branch).
            let Ok(raw) = self.git(&["log", "-1", "--format=%H%x00%s", &format!("refs/heads/{name}"), "--"]) else { continue };
            let text = String::from_utf8_lossy(&raw);
            let (oid, subject) = text.trim().split_once('\0').unwrap_or(("", ""));
            if oid.is_empty() {
                continue;
            }
            out.push(RecentBranch { name, oid: oid.to_string(), subject: subject.to_string(), time });
        }
        Ok(out)
    }
}
