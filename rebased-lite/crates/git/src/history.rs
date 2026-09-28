//! File history (log of one file, across renames) and annotate (blame).

use crate::{GitError, Repo, Result};
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub oid: String,
    pub parents: Vec<String>,
    pub subject: String,
    pub author: String,
    pub time: i64,
    /// A, M, D, R, C, T; empty for a merge commit, which has no file list.
    pub status: String,
    /// The path of the file in this commit.
    pub path: String,
    pub old_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameCommit {
    pub oid: String,
    pub author: String,
    pub time: i64,
    pub summary: String,
    /// The line is not committed yet.
    pub uncommitted: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Blame {
    pub commits: Vec<BlameCommit>,
    /// For each line of the file, an index into `commits`.
    pub lines: Vec<u32>,
}

pub const MAX_HISTORY: usize = 5000;

impl Repo {
    /// The commits that changed a file, newest first. It follows renames, as IntelliJ's Show History does.
    pub fn file_history(&self, path: &str) -> Result<Vec<HistoryEntry>> {
        if path.is_empty() || path.starts_with('-') {
            return Err(GitError(format!("invalid path {path:?}")));
        }
        let n = format!("-n{MAX_HISTORY}");
        let raw = self.git(&["log", "--follow", "-M", &n, "--name-status", "--format=%x1e%H%x1f%P%x1f%s%x1f%an%x1f%at", "--", path])?;
        let text = String::from_utf8_lossy(&raw);
        let mut out = Vec::new();
        let mut current = path.to_string();
        for rec in text.split('\x1e').filter(|r| !r.trim().is_empty()) {
            let mut lines = rec.lines();
            let header = lines.next().unwrap_or("");
            let mut f = header.split('\x1f');
            let (Some(oid), Some(parents), Some(subject), Some(author), Some(time)) = (f.next(), f.next(), f.next(), f.next(), f.next()) else {
                continue;
            };
            let mut status = String::new();
            let mut old_path = None;
            let mut file = current.clone();
            if let Some(l) = lines.find(|l| !l.trim().is_empty()) {
                let parts: Vec<&str> = l.split('\t').collect();
                status = parts[0].chars().next().map(String::from).unwrap_or_default();
                match parts.as_slice() {
                    [_, old, new] => {
                        old_path = Some(old.to_string());
                        file = new.to_string();
                    }
                    [_, p] => file = p.to_string(),
                    _ => {}
                }
            }
            out.push(HistoryEntry {
                oid: oid.to_string(),
                parents: parents.split_whitespace().map(String::from).collect(),
                subject: subject.to_string(),
                author: author.to_string(),
                time: time.trim().parse().unwrap_or(0),
                status,
                path: file,
                old_path: old_path.clone(),
            });
            // Older commits see the file under its old name.
            if let Some(o) = old_path {
                current = o;
            }
        }
        Ok(out)
    }

    /// Annotates each line of a file with the commit that last changed it. With no revision, it annotates
    /// the working tree file; uncommitted lines get an `uncommitted` entry.
    pub fn blame(&self, rev: Option<&str>, path: &str) -> Result<Blame> {
        if path.is_empty() || path.starts_with('-') || rev.is_some_and(|r| r.starts_with('-')) {
            return Err(GitError(format!("invalid path {path:?}")));
        }
        let mut args = vec!["blame", "--porcelain"];
        if let Some(r) = rev {
            args.push(r);
        }
        args.extend(["--", path]);
        let raw = self.git(&args)?;
        let text = String::from_utf8_lossy(&raw);
        let mut commits: Vec<BlameCommit> = Vec::new();
        let mut index: HashMap<String, u32> = HashMap::new();
        let mut lines = Vec::new();
        let mut current: Option<u32> = None;
        for l in text.lines() {
            if l.starts_with('\t') {
                if let Some(c) = current {
                    lines.push(c);
                }
                continue;
            }
            let (key, value) = l.split_once(' ').unwrap_or((l, ""));
            if key.len() == 40 && key.bytes().all(|b| b.is_ascii_hexdigit()) {
                let i = *index.entry(key.to_string()).or_insert_with(|| {
                    commits.push(BlameCommit {
                        oid: key.to_string(),
                        author: String::new(),
                        time: 0,
                        summary: String::new(),
                        uncommitted: key.bytes().all(|b| b == b'0'),
                    });
                    (commits.len() - 1) as u32
                });
                current = Some(i);
                continue;
            }
            let Some(c) = current.and_then(|i| commits.get_mut(i as usize)) else { continue };
            match key {
                "author" => c.author = value.to_string(),
                "author-time" => c.time = value.parse().unwrap_or(0),
                "summary" => c.summary = value.to_string(),
                _ => {}
            }
        }
        Ok(Blame { commits, lines })
    }
}
