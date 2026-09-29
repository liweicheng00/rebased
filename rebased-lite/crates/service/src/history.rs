//! Local History, as in IntelliJ: versions of working-tree files that the app keeps apart from git.
//!
//! The store is in `<git dir>/rebased-lite/local-history`. `index.jsonl` has one line for each version.
//! `blobs/` has the content, compressed and named by its SHA-256. The watcher adds a version when a file
//! changes. An operation that can lose local changes adds a version of each affected file before it runs.

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// The store skips a file larger than this, as IntelliJ does.
const MAX_FILE_SIZE: u64 = 2 * 1024 * 1024;
/// A change of more files than this at one time comes from a checkout or a similar operation. The
/// store skips it, because git has these versions.
pub const MAX_BULK_FILES: usize = 200;
/// The store removes old versions after this number of new versions.
const PRUNE_EVERY: usize = 500;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    /// Versions older than this are removed.
    pub days: u32,
    /// The store removes the oldest versions when the blobs are larger than this.
    pub max_mb: u32,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits { days: 5, max_mb: 200 }
    }
}

/// One line of `index.jsonl`.
#[derive(Clone, Debug, Deserialize, Serialize)]
struct Line {
    /// The time in milliseconds.
    t: i64,
    /// The path, relative to the root of the working tree, with `/`.
    p: String,
    /// The SHA-256 of the content. None when the file did not exist.
    b: Option<String>,
    /// Why the version was made, for example "Before Rollback". Empty for a change on disk.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    l: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    pub time: i64,
    pub path: String,
    /// None when the file did not exist at this time.
    pub blob: Option<String>,
    pub label: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Content {
    pub text: Option<String>,
    pub binary: bool,
    pub missing: bool,
}

struct Inner {
    /// The last version of each path, so an unchanged file adds no version.
    last: HashMap<String, Option<String>>,
    since_prune: usize,
    limits: Limits,
}

pub struct LocalHistory {
    root: PathBuf,
    git_dir: PathBuf,
    dir: PathBuf,
    inner: Mutex<Inner>,
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

impl LocalHistory {
    pub fn open(root: &Path, git_dir: &Path, limits: Limits) -> LocalHistory {
        let h = LocalHistory {
            root: root.to_path_buf(),
            git_dir: git_dir.to_path_buf(),
            dir: git_dir.join("rebased-lite").join("local-history"),
            inner: Mutex::new(Inner { last: HashMap::new(), since_prune: 0, limits }),
        };
        let lines = h.prune();
        let mut inner = h.inner.lock().unwrap();
        for l in lines {
            inner.last.insert(l.p, l.b);
        }
        drop(inner);
        h
    }

    pub fn set_limits(&self, limits: Limits) {
        self.inner.lock().unwrap().limits = limits;
        self.prune();
    }

    fn index(&self) -> PathBuf {
        self.dir.join("index.jsonl")
    }

    fn blob_path(&self, hash: &str) -> PathBuf {
        self.dir.join("blobs").join(&hash[..2]).join(&hash[2..])
    }

    fn read_lines(&self) -> Vec<Line> {
        let Ok(f) = std::fs::File::open(self.index()) else { return Vec::new() };
        BufReader::new(f).lines().map_while(|l| l.ok()).filter_map(|l| serde_json::from_str(&l).ok()).collect()
    }

    fn relative(&self, path: &Path) -> Option<String> {
        let rel = if path.is_absolute() { path.strip_prefix(&self.root).ok()? } else { path };
        let s = rel.to_string_lossy().replace('\\', "/");
        (!s.is_empty()).then_some(s)
    }

    /// Adds a version of each file that changed since its last version. `paths` are absolute or relative
    /// to the root.
    pub fn record(&self, paths: &[PathBuf], label: &str) {
        // The repository was deleted: do not make its git dir again.
        if !self.git_dir.is_dir() {
            return;
        }
        let mut lines = Vec::new();
        let mut inner = self.inner.lock().unwrap();
        for p in paths {
            let Some(rel) = self.relative(p) else { continue };
            let abs = self.root.join(&rel);
            let blob = match std::fs::metadata(&abs) {
                Ok(m) if m.is_dir() => continue,
                Ok(m) if m.len() > MAX_FILE_SIZE => continue,
                Ok(_) => match std::fs::read(&abs) {
                    Ok(bytes) => match self.store(&bytes) {
                        Some(h) => Some(h),
                        None => continue,
                    },
                    Err(_) => continue,
                },
                Err(_) => None,
            };
            let last = inner.last.get(&rel);
            // A label marks a point before an operation, so the version is useful even without a change.
            if label.is_empty() && last == Some(&blob) {
                continue;
            }
            // A file that never had a version and does not exist has nothing to keep.
            if blob.is_none() && last.is_none_or(|b| b.is_none()) {
                continue;
            }
            inner.last.insert(rel.clone(), blob.clone());
            lines.push(Line { t: now_ms(), p: rel, b: blob, l: label.to_string() });
        }
        if lines.is_empty() {
            return;
        }
        let text: String = lines.iter().filter_map(|l| serde_json::to_string(l).ok()).map(|s| s + "\n").collect();
        let _ = std::fs::create_dir_all(&self.dir);
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(self.index()) {
            let _ = f.write_all(text.as_bytes());
        }
        inner.since_prune += lines.len();
        if inner.since_prune >= PRUNE_EVERY {
            drop(inner);
            self.prune();
        }
    }

    fn store(&self, bytes: &[u8]) -> Option<String> {
        let hash = format!("{:x}", Sha256::digest(bytes));
        let path = self.blob_path(&hash);
        if !path.exists() {
            std::fs::create_dir_all(path.parent()?).ok()?;
            let tmp = path.with_extension("tmp");
            let mut enc = GzEncoder::new(std::fs::File::create(&tmp).ok()?, flate2::Compression::fast());
            enc.write_all(bytes).ok()?;
            enc.finish().ok()?;
            std::fs::rename(&tmp, &path).ok()?;
        }
        Some(hash)
    }

    pub fn blob(&self, hash: &str) -> Option<Vec<u8>> {
        if hash.len() < 3 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let mut out = Vec::new();
        GzDecoder::new(std::fs::File::open(self.blob_path(hash)).ok()?).read_to_end(&mut out).ok()?;
        Some(out)
    }

    pub fn content(&self, hash: Option<&str>) -> Content {
        match hash.and_then(|h| self.blob(h)) {
            Some(bytes) => {
                let binary = bytes.iter().take(8000).any(|&b| b == 0);
                Content { text: (!binary).then(|| String::from_utf8_lossy(&bytes).into_owned()), binary, missing: false }
            }
            None => Content { text: None, binary: false, missing: true },
        }
    }

    /// The versions of one path, or of all paths, newest first.
    pub fn revisions(&self, path: Option<&str>, limit: usize) -> Vec<Revision> {
        let _guard = self.inner.lock().unwrap();
        let mut lines = self.read_lines();
        if let Some(p) = path {
            let p = p.trim_end_matches('/');
            let dir = format!("{p}/");
            lines.retain(|l| l.p == p || l.p.starts_with(&dir));
        }
        lines.into_iter().rev().take(limit).map(|l| Revision { time: l.t, path: l.p, blob: l.b, label: l.l }).collect()
    }

    /// Removes the versions that are too old or over the size limit, and the blobs that no version uses.
    /// Returns the versions that stay.
    fn prune(&self) -> Vec<Line> {
        let mut inner = self.inner.lock().unwrap();
        inner.since_prune = 0;
        let limits = inner.limits;
        let mut lines = self.read_lines();
        let before = lines.len();
        let oldest = now_ms() - i64::from(limits.days) * 24 * 3600 * 1000;
        lines.retain(|l| l.t >= oldest);
        // Keep the newest versions up to the size limit.
        let mut sizes: HashMap<String, u64> = HashMap::new();
        let mut total = 0u64;
        let max = u64::from(limits.max_mb) * 1024 * 1024;
        let mut keep_from = 0;
        for (i, l) in lines.iter().enumerate().rev() {
            if let Some(b) = &l.b {
                if !sizes.contains_key(b) {
                    let s = std::fs::metadata(self.blob_path(b)).map_or(0, |m| m.len());
                    sizes.insert(b.clone(), s);
                    total += s;
                }
            }
            if total > max {
                keep_from = i + 1;
                break;
            }
        }
        lines.drain(..keep_from);
        if lines.len() != before {
            let text: String = lines.iter().filter_map(|l| serde_json::to_string(l).ok()).map(|s| s + "\n").collect();
            let tmp = self.dir.join("index.jsonl.tmp");
            if std::fs::write(&tmp, text).is_ok() {
                let _ = std::fs::rename(&tmp, self.index());
            }
            let used: HashSet<&str> = lines.iter().filter_map(|l| l.b.as_deref()).collect();
            for d in std::fs::read_dir(self.dir.join("blobs")).into_iter().flatten().flatten() {
                let prefix = d.file_name().to_string_lossy().into_owned();
                for f in std::fs::read_dir(d.path()).into_iter().flatten().flatten() {
                    let hash = format!("{prefix}{}", f.file_name().to_string_lossy());
                    if !used.contains(hash.as_str()) {
                        let _ = std::fs::remove_file(f.path());
                    }
                }
            }
        }
        lines
    }

    /// Writes a version back to the working tree. It first adds a version of the current content, so
    /// the revert can be reverted.
    pub fn revert(&self, path: &str, blob: Option<&str>) -> Result<(), String> {
        let rel = self.relative(Path::new(path)).ok_or("The path is not in the working tree")?;
        if rel.split('/').any(|c| c == "..") {
            return Err("The path is not in the working tree".into());
        }
        let abs = self.root.join(&rel);
        self.record(std::slice::from_ref(&abs), "Before revert");
        match blob {
            Some(h) => {
                let bytes = self.blob(h).ok_or("The version is no longer in Local History")?;
                if let Some(parent) = abs.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                std::fs::write(&abs, bytes).map_err(|e| e.to_string())?;
            }
            None => {
                if abs.exists() {
                    std::fs::remove_file(&abs).map_err(|e| e.to_string())?;
                }
            }
        }
        self.record(std::slice::from_ref(&abs), "");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prune_removes_versions_and_blobs() {
        let root = std::env::temp_dir().join(format!("rebased-lite-prune-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join(".git")).unwrap();
        let h = LocalHistory::open(&root, &root.join(".git"), Limits::default());
        std::fs::write(root.join("a.txt"), "one").unwrap();
        h.record(&[PathBuf::from("a.txt")], "");
        std::fs::write(root.join("a.txt"), "two").unwrap();
        h.record(&[PathBuf::from("a.txt")], "");
        // An unchanged file adds no version.
        h.record(&[PathBuf::from("a.txt")], "");
        assert_eq!(h.revisions(None, 10).len(), 2);
        let old = h.revisions(None, 10)[1].blob.clone().unwrap();

        // Reopen: the versions stay.
        let h = LocalHistory::open(&root, &root.join(".git"), Limits::default());
        assert_eq!(h.revisions(Some("a.txt"), 10).len(), 2);

        // A size limit of zero removes all versions and their blobs.
        h.set_limits(Limits { days: 5, max_mb: 0 });
        assert!(h.revisions(None, 10).is_empty());
        assert!(h.blob(&old).is_none());
    }
}
