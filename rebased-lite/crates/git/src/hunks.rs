//! The changes (hunks) of a local file, for partial changelists: the hunks of one file can be in
//! different changelists, as in IntelliJ.
//!
//! A hunk comes from `git diff -U0 HEAD`. Its id is a hash of its removed and added lines, so the id
//! stays the same when other hunks of the file change. Two hunks with the same lines get the suffixes
//! `#2`, `#3`, and so on.

use crate::{Repo, Result};
use serde::Serialize;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[derive(ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub id: String,
    /// The first removed line in HEAD, 1-based. With no removed lines, the line after which the hunk adds.
    pub old_start: u32,
    pub old_lines: u32,
    /// The first added line in the working tree, 1-based. With no added lines, the line after which the
    /// hunk removes.
    pub new_start: u32,
    pub new_lines: u32,
    /// Set by the changelists: the changelist of this hunk.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub list: String,
    /// The removed lines, with their line breaks.
    #[serde(skip)]
    pub removed: Vec<String>,
    /// The added lines, with their line breaks.
    #[serde(skip)]
    pub added: Vec<String>,
}

impl Hunk {
    /// True when the hunk covers the working-tree line. A hunk that only removes covers the lines next
    /// to the removal.
    pub fn covers(&self, line: u32) -> bool {
        if self.new_lines == 0 {
            line == self.new_start || line == self.new_start + 1
        } else {
            line >= self.new_start && line < self.new_start + self.new_lines
        }
    }
}

/// FNV-1a: a stable hash that needs no dependency.
fn fnv(parts: &[&str]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for p in parts {
        for b in p.bytes().chain(std::iter::once(0xff)) {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
    }
    h
}

fn range(s: &str) -> Option<(u32, u32)> {
    match s.split_once(',') {
        Some((a, b)) => Some((a.parse().ok()?, b.parse().ok()?)),
        None => Some((s.parse().ok()?, 1)),
    }
}

/// Parses the output of `git diff -U0` for one file.
pub fn parse(diff: &str) -> Vec<Hunk> {
    let mut hunks: Vec<Hunk> = Vec::new();
    // The last line read: '-' or '+', for the "\ No newline at end of file" marker.
    let mut last = ' ';
    for line in diff.split_inclusive('\n') {
        if let Some(rest) = line.strip_prefix("@@ -") {
            let Some((ranges, _)) = rest.split_once(" @@") else { continue };
            let Some((old, new)) = ranges.split_once(" +") else { continue };
            let (Some((os, ol)), Some((ns, nl))) = (range(old), range(new)) else { continue };
            hunks.push(Hunk {
                id: String::new(),
                old_start: os,
                old_lines: ol,
                new_start: ns,
                new_lines: nl,
                list: String::new(),
                removed: Vec::new(),
                added: Vec::new(),
            });
            last = ' ';
            continue;
        }
        let Some(h) = hunks.last_mut() else { continue };
        if let Some(t) = line.strip_prefix('-') {
            h.removed.push(t.to_string());
            last = '-';
        } else if let Some(t) = line.strip_prefix('+') {
            h.added.push(t.to_string());
            last = '+';
        } else if line.starts_with('\\') {
            // The line before has no line break at the end of the file.
            let side = if last == '-' { &mut h.removed } else { &mut h.added };
            if let Some(l) = side.last_mut() {
                if l.ends_with('\n') {
                    l.pop();
                }
            }
        }
    }
    let mut seen: std::collections::HashMap<u64, u32> = std::collections::HashMap::new();
    for h in &mut hunks {
        let mut parts: Vec<&str> = h.removed.iter().map(String::as_str).collect();
        parts.push("\u{0}+");
        parts.extend(h.added.iter().map(String::as_str));
        let hash = fnv(&parts);
        let n = seen.entry(hash).or_insert(0);
        *n += 1;
        h.id = if *n == 1 { format!("{hash:016x}") } else { format!("{hash:016x}#{n}") };
    }
    hunks
}

/// Applies the chosen hunks to the HEAD content. The other hunks stay as in HEAD.
pub fn apply(base: &str, hunks: &[Hunk], chosen: &dyn Fn(&Hunk) -> bool) -> String {
    let lines: Vec<&str> = base.split_inclusive('\n').collect();
    let mut out = String::with_capacity(base.len());
    // The next HEAD line to copy, 0-based.
    let mut next = 0usize;
    for h in hunks {
        // The HEAD lines before the hunk: with no removed lines, the hunk adds after line old_start.
        let start = if h.old_lines == 0 { h.old_start as usize } else { h.old_start as usize - 1 };
        let start = start.min(lines.len());
        for l in &lines[next.min(start)..start] {
            out.push_str(l);
        }
        let end = (start + h.old_lines as usize).min(lines.len());
        if chosen(h) {
            for l in &h.added {
                out.push_str(l);
            }
        } else {
            for l in &lines[start..end] {
                out.push_str(l);
            }
        }
        next = end;
    }
    for l in &lines[next.min(lines.len())..] {
        out.push_str(l);
    }
    out
}

impl Repo {
    /// The hunks of a tracked file from HEAD to the working tree. A binary file has none.
    pub fn file_hunks(&self, path: &str) -> Result<Vec<Hunk>> {
        let raw = self.git(&["diff", "-U0", "--no-color", "--no-ext-diff", "--no-renames", "HEAD", "--", path])?;
        let text = String::from_utf8_lossy(&raw);
        if text.lines().any(|l| l.starts_with("Binary files ")) {
            return Ok(Vec::new());
        }
        Ok(parse(&text))
    }

    /// The content of a file with only the chosen hunks of its local changes.
    pub fn content_with_hunks(&self, path: &str, ids: &[String]) -> Result<String> {
        let hunks = self.file_hunks(path)?;
        let base = self.git(&["show", &format!("HEAD:{path}")]).unwrap_or_default();
        let base = String::from_utf8_lossy(&base);
        Ok(apply(&base, &hunks, &|h| ids.contains(&h.id)))
    }
}

impl Repo {
    /// Rolls back some hunks of a file: the working tree gets HEAD plus the other hunks.
    pub fn rollback_hunks(&self, path: &str, ids: &[String]) -> Result<crate::ops::OpResult> {
        let hunks = self.file_hunks(path)?;
        if !hunks.iter().any(|h| ids.contains(&h.id)) {
            return Err(crate::GitError("The changes to roll back are gone. Refresh and try again".into()));
        }
        let base = self.git(&["show", &format!("HEAD:{path}")])?;
        let content = apply(&String::from_utf8_lossy(&base), &hunks, &|h| !ids.contains(&h.id));
        std::fs::write(self.root.join(path), content).map_err(|e| crate::GitError(e.to_string()))?;
        let n = hunks.iter().filter(|h| ids.contains(&h.id)).count();
        Ok(crate::ops::OpResult::ok_msg(format!("Rolled back {n} change{} of {path}", if n == 1 { "" } else { "s" })))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIFF: &str = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-one\n+ONE\n@@ -3,0 +4,2 @@\n+new a\n+new b\n@@ -5 +6,0 @@\n-five\n";
    const BASE: &str = "one\ntwo\nthree\nfour\nfive\nsix\n";

    #[test]
    fn parses_and_applies() {
        let h = parse(DIFF);
        assert_eq!(h.len(), 3);
        assert_eq!((h[1].old_start, h[1].old_lines, h[1].new_start, h[1].new_lines), (3, 0, 4, 2));
        assert!(h[1].covers(4) && h[1].covers(5) && !h[1].covers(6));
        assert!(h[2].covers(6) && h[2].covers(7));
        assert_eq!(apply(BASE, &h, &|_| true), "ONE\ntwo\nthree\nnew a\nnew b\nfour\nsix\n");
        assert_eq!(apply(BASE, &h, &|_| false), BASE);
        assert_eq!(apply(BASE, &h, &|x| x.id == h[1].id), "one\ntwo\nthree\nnew a\nnew b\nfour\nfive\nsix\n");
        assert_eq!(apply(BASE, &h, &|x| x.id != h[1].id), "ONE\ntwo\nthree\nfour\nsix\n");
    }

    #[test]
    fn ids_are_stable_and_unique() {
        let a = parse(DIFF);
        // Another hunk before these ones moves their line numbers, not their ids.
        let shifted = DIFF.replace("@@ -3,0 +4,2 @@", "@@ -3,0 +9,2 @@");
        assert_eq!(parse(&shifted)[1].id, a[1].id);
        let twice = "@@ -1 +1 @@\n-x\n+y\n@@ -5 +5 @@\n-x\n+y\n";
        let t = parse(twice);
        assert_ne!(t[0].id, t[1].id);
        assert!(t[1].id.ends_with("#2"));
    }

    #[test]
    fn no_newline_at_end() {
        let diff = "@@ -2 +2 @@\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n";
        let h = parse(diff);
        assert_eq!(h[0].removed, vec!["b"]);
        assert_eq!(h[0].added, vec!["c"]);
        assert_eq!(apply("a\nb", &h, &|_| true), "a\nc");
    }
}
