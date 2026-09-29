//! Repository access through the git CLI. The git CLI respects the user's config, hooks and credentials,
//! the same way IntelliJ does. See `docs/rebased-lite/design-spec.md`, chapters 3 and 6.

pub mod changelist;
pub mod history;
pub mod merge;
pub mod ops;
pub mod remote;
pub mod stash;
pub mod worktree;

use rebased_graph::linear::GraphCommit;
use rebased_graph::{Graph, GraphOptions, RefInfo, RefKind};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug)]
pub struct GitError(pub String);

impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for GitError {}

pub type Result<T> = std::result::Result<T, GitError>;

pub struct Repo {
    pub root: PathBuf,
}

/// Environment for git commands that can ask for credentials: the askpass program of the app.
static NETWORK_ENV: std::sync::RwLock<Vec<(String, String)>> = std::sync::RwLock::new(Vec::new());

pub fn set_network_env(vars: Vec<(String, String)>) {
    *NETWORK_ENV.write().unwrap() = vars;
}

pub fn network_env() -> Vec<(String, String)> {
    NETWORK_ENV.read().unwrap().clone()
}

fn run_git(dir: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "core.quotePath=false", "-c", "log.showSignature=false"])
        .args(args)
        // Reads must not refresh the index: the file watcher would see the write and reload again.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .map_err(|e| GitError(format!("cannot run git: {e}")))?;
    if !out.status.success() {
        return Err(GitError(format!("git {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim())));
    }
    Ok(out.stdout)
}

#[derive(Clone, Debug, Serialize)]
pub struct RefLabel {
    pub name: String,
    pub kind: &'static str,
}

/// Commit topology in `--date-order`, plus refs. Oids are stored as raw bytes.
pub struct Topology {
    pub oids: Vec<[u8; 20]>,
    pub timestamps: Vec<i64>,
    pub parents: Vec<Vec<[u8; 20]>>,
    pub refs: Vec<Vec<RefInfo>>,
    pub head: Option<String>,
    index: HashMap<[u8; 20], usize>,
}

impl Topology {
    pub fn oid_hex(&self, node: usize) -> String {
        hex(&self.oids[node])
    }

    pub fn node_of(&self, oid_hex: &str) -> Option<usize> {
        self.index.get(&unhex(oid_hex)?).copied()
    }

    pub fn ref_labels(&self, node: usize) -> Vec<RefLabel> {
        let mut refs = self.refs[node].clone();
        refs.sort_by(|a, b| label_rank(a.kind).cmp(&label_rank(b.kind)).then_with(|| a.name.cmp(&b.name)));
        refs.into_iter()
            .map(|r| RefLabel {
                kind: match r.kind {
                    RefKind::Head => "head",
                    RefKind::CurrentBranch | RefKind::Master | RefKind::LocalBranch => "local",
                    RefKind::OriginMaster | RefKind::RemoteBranch => "remote",
                    RefKind::Tag => "tag",
                    RefKind::Other => "other",
                },
                name: r.name,
            })
            .collect()
    }
}

fn label_rank(k: RefKind) -> u8 {
    match k {
        RefKind::Head => 0,
        RefKind::CurrentBranch => 1,
        RefKind::Master => 2,
        RefKind::OriginMaster => 3,
        RefKind::LocalBranch => 4,
        RefKind::RemoteBranch => 5,
        RefKind::Tag => 6,
        RefKind::Other => 7,
    }
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex(s: &str) -> Option<[u8; 20]> {
    if s.len() != 40 {
        return None;
    }
    let mut out = [0u8; 20];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).ok()?;
    }
    Some(out)
}

#[derive(Clone, Debug, Serialize)]
pub struct CommitDetails {
    pub oid: String,
    pub subject: String,
    pub author: String,
    pub author_email: String,
    pub author_time: i64,
    pub body: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Change {
    /// A, M, D, R, C, T
    pub status: char,
    pub path: String,
    pub old_path: Option<String>,
}

/// A revision for comparison: a commit oid, the empty tree, or the working tree.
#[derive(Clone, Debug)]
pub enum Rev {
    Commit(String),
    EmptyTree,
    WorkTree,
}

#[derive(Clone, Debug, Serialize)]
pub struct FileContent {
    pub text: Option<String>,
    pub binary: bool,
    pub size: usize,
    pub missing: bool,
}

pub const MAX_TEXT_SIZE: usize = 5 * 1024 * 1024;

impl Repo {
    pub fn open(path: &Path) -> Result<Repo> {
        let out = run_git(path, &["rev-parse", "--show-toplevel"])?;
        let root = String::from_utf8_lossy(&out).trim().to_string();
        Ok(Repo { root: PathBuf::from(root) })
    }

    pub fn git(&self, args: &[&str]) -> Result<Vec<u8>> {
        run_git(&self.root, args)
    }

    /// Same revision set as IntelliJ `GitLogUtil.LOG_ALL` plus `--date-order`.
    pub fn load_topology(&self) -> Result<Topology> {
        let head = self.git(&["symbolic-ref", "-q", "HEAD"]).ok().map(|b| String::from_utf8_lossy(&b).trim().to_string());
        let has_head = self.git(&["rev-parse", "-q", "--verify", "HEAD"]).is_ok();
        let mut args = vec!["log", "--date-order", "--format=%H %ct %P", "--branches", "--remotes", "--tags"];
        if has_head {
            args.insert(1, "HEAD");
        }
        let raw = self.git(&args)?;
        let text = String::from_utf8_lossy(&raw);

        let mut oids = Vec::new();
        let mut timestamps = Vec::new();
        let mut parents_hex: Vec<Vec<[u8; 20]>> = Vec::new();
        for line in text.lines() {
            let mut parts = line.split(' ');
            let (Some(oid), Some(ts)) = (parts.next(), parts.next()) else { continue };
            let Some(oid) = unhex(oid) else { continue };
            oids.push(oid);
            timestamps.push(ts.parse().unwrap_or(0));
            parents_hex.push(parts.filter_map(unhex).collect());
        }
        let index: HashMap<[u8; 20], usize> = oids.iter().enumerate().map(|(i, o)| (*o, i)).collect();

        let mut refs: Vec<Vec<RefInfo>> = vec![Vec::new(); oids.len()];
        let raw_refs = self.git(&[
            "for-each-ref",
            "--format=%(objectname) %(*objectname) %(refname)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ])?;
        for line in String::from_utf8_lossy(&raw_refs).lines() {
            let mut p = line.splitn(3, ' ');
            let (Some(obj), Some(peeled), Some(name)) = (p.next(), p.next(), p.next()) else { continue };
            let target = if peeled.is_empty() { obj } else { peeled };
            let Some(node) = unhex(target).and_then(|o| index.get(&o).copied()) else { continue };
            if name.ends_with("/HEAD") && name.starts_with("refs/remotes/") {
                continue;
            }
            refs[node].push(ref_info(name, head.as_deref()));
        }
        if has_head && head.is_none() {
            // Detached HEAD: show a HEAD label.
            if let Ok(b) = self.git(&["rev-parse", "HEAD"]) {
                if let Some(node) = unhex(String::from_utf8_lossy(&b).trim()).and_then(|o| index.get(&o).copied()) {
                    refs[node].push(RefInfo { name: "HEAD".into(), kind: RefKind::Head });
                }
            }
        }

        Ok(Topology { oids, timestamps, parents: parents_hex, refs, head, index })
    }

    pub fn build_graph(&self, topo: &Topology, options: &GraphOptions) -> Graph {
        let commits: Vec<GraphCommit<[u8; 20]>> =
            topo.oids.iter().zip(&topo.parents).map(|(id, parents)| GraphCommit { id: *id, parents: parents.clone() }).collect();
        Graph::build(&commits, &topo.timestamps, &topo.refs, options)
    }

    pub fn commit_details(&self, oids: &[String]) -> Result<Vec<CommitDetails>> {
        if oids.is_empty() {
            return Ok(Vec::new());
        }
        let mut args = vec!["log", "--no-walk=unsorted", "-z", "--format=%H%x00%s%x00%an%x00%ae%x00%at%x00%b"];
        args.extend(oids.iter().map(String::as_str));
        let raw = self.git(&args)?;
        let text = String::from_utf8_lossy(&raw);
        let fields: Vec<&str> = text.split('\0').collect();
        let mut result = Vec::new();
        for chunk in fields.chunks(6) {
            if chunk.len() < 6 {
                break;
            }
            result.push(CommitDetails {
                oid: chunk[0].trim_start_matches('\n').to_string(),
                subject: chunk[1].to_string(),
                author: chunk[2].to_string(),
                author_email: chunk[3].to_string(),
                author_time: chunk[4].parse().unwrap_or(0),
                body: chunk[5].trim_end().to_string(),
            });
        }
        Ok(result)
    }

    pub fn first_parent(&self, oid: &str) -> Result<Rev> {
        let raw = self.git(&["rev-list", "--parents", "-n", "1", oid])?;
        let text = String::from_utf8_lossy(&raw);
        Ok(match text.split_whitespace().nth(1) {
            Some(p) => Rev::Commit(p.to_string()),
            None => Rev::EmptyTree,
        })
    }

    pub(crate) fn empty_tree(&self) -> Result<String> {
        let out = Command::new("git")
            .arg("-C")
            .arg(&self.root)
            .args(["hash-object", "-t", "tree", "--stdin"])
            .stdin(std::process::Stdio::null())
            .output()
            .map_err(|e| GitError(e.to_string()))?;
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    fn rev_arg(&self, rev: &Rev) -> Result<Option<String>> {
        Ok(match rev {
            Rev::Commit(o) => Some(o.clone()),
            Rev::EmptyTree => Some(self.empty_tree()?),
            Rev::WorkTree => None,
        })
    }

    /// Changed files from `left` to `right`, with rename and copy detection.
    pub fn list_changes(&self, left: &Rev, right: &Rev) -> Result<Vec<Change>> {
        let l = self.rev_arg(left)?.ok_or_else(|| GitError("left side cannot be the working tree".into()))?;
        let r = self.rev_arg(right)?;
        let mut args = vec!["diff", "--name-status", "-M", "-C", "-z", l.as_str()];
        if let Some(r) = r.as_deref() {
            args.push(r);
        }
        let raw = self.git(&args)?;
        let mut changes = parse_name_status(&raw);
        if matches!(right, Rev::WorkTree) {
            let raw = self.git(&["ls-files", "--others", "--exclude-standard", "-z"])?;
            for p in raw.split(|&b| b == 0).filter(|p| !p.is_empty()) {
                changes.push(Change { status: 'A', path: String::from_utf8_lossy(p).into_owned(), old_path: None });
            }
        }
        changes.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(changes)
    }

    pub fn file_content(&self, rev: &Rev, path: &str) -> Result<FileContent> {
        let bytes = match rev {
            Rev::WorkTree => match std::fs::read(self.root.join(path)) {
                Ok(b) => b,
                Err(_) => return Ok(FileContent { text: None, binary: false, size: 0, missing: true }),
            },
            Rev::EmptyTree => return Ok(FileContent { text: None, binary: false, size: 0, missing: true }),
            Rev::Commit(oid) => match self.git(&["show", &format!("{oid}:{path}")]) {
                Ok(b) => b,
                Err(_) => return Ok(FileContent { text: None, binary: false, size: 0, missing: true }),
            },
        };
        let size = bytes.len();
        let binary = bytes.iter().take(8000).any(|&b| b == 0);
        let text = if binary || size > MAX_TEXT_SIZE { None } else { Some(String::from_utf8_lossy(&bytes).into_owned()) };
        Ok(FileContent { text, binary, size, missing: false })
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct BranchInfo {
    pub name: String,
    pub full: String,
    /// local, remote or tag
    pub kind: &'static str,
    pub oid: String,
    pub current: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub subject: String,
}

#[derive(Clone, Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LogFilter {
    /// Branch, remote or tag names. Empty means all refs. A name with a leading `^` excludes the commits
    /// of that ref, so `["feature", "^main"]` shows the commits of feature that are not in main.
    pub branches: Vec<String>,
    pub author: String,
    pub text: String,
    pub path: String,
    /// Passed to `git log --since`, for example "2.weeks".
    pub since: String,
}

impl LogFilter {
    /// A filter that git must evaluate (the branch filter alone is computed from the graph).
    pub fn needs_git(&self) -> bool {
        self.branches.iter().any(|b| b.starts_with('^'))
            || !(self.author.trim().is_empty() && self.text.trim().is_empty() && self.path.trim().is_empty() && self.since.trim().is_empty())
    }

    pub fn is_empty(&self) -> bool {
        self.branches.is_empty() && !self.needs_git()
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct CommitFull {
    pub oid: String,
    pub parents: Vec<String>,
    pub subject: String,
    pub body: String,
    pub author: String,
    pub author_email: String,
    pub author_time: i64,
    pub committer: String,
    pub committer_email: String,
    pub commit_time: i64,
}

impl Repo {
    pub fn list_refs(&self) -> Result<Vec<BranchInfo>> {
        let raw = self.git(&[
            "for-each-ref",
            "--format=%(refname)%00%(objectname)%00%(*objectname)%00%(HEAD)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(contents:subject)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ])?;
        let mut out = Vec::new();
        for line in String::from_utf8_lossy(&raw).lines() {
            let f: Vec<&str> = line.split('\0').collect();
            if f.len() < 7 || (f[0].starts_with("refs/remotes/") && f[0].ends_with("/HEAD")) {
                continue;
            }
            let (kind, name) = if let Some(n) = f[0].strip_prefix("refs/heads/") {
                ("local", n)
            } else if let Some(n) = f[0].strip_prefix("refs/remotes/") {
                ("remote", n)
            } else {
                ("tag", f[0].trim_start_matches("refs/tags/"))
            };
            let (mut ahead, mut behind) = (0, 0);
            for part in f[5].split(", ") {
                if let Some(n) = part.strip_prefix("ahead ") {
                    ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix("behind ") {
                    behind = n.parse().unwrap_or(0);
                }
            }
            out.push(BranchInfo {
                name: name.to_string(),
                full: f[0].to_string(),
                kind,
                oid: if f[2].is_empty() { f[1] } else { f[2] }.to_string(),
                current: f[3] == "*",
                upstream: (!f[4].is_empty()).then(|| f[4].to_string()),
                ahead,
                behind,
                subject: f[6].to_string(),
            });
        }
        Ok(out)
    }

    /// Commits that match the git-side parts of `filter`, over `revs` (all refs when empty).
    pub fn matching_commits(&self, filter: &LogFilter, revs: &[String]) -> Result<std::collections::HashSet<[u8; 20]>> {
        let mut args: Vec<String> = vec!["log".into(), "--format=%H".into(), "--regexp-ignore-case".into()];
        if revs.is_empty() {
            args.extend(["--branches", "--remotes", "--tags"].map(String::from));
            if self.git(&["rev-parse", "-q", "--verify", "HEAD"]).is_ok() {
                args.push("HEAD".into());
            }
        } else {
            args.extend(revs.iter().filter(|r| !r.starts_with('-')).cloned());
        }
        if !filter.author.trim().is_empty() {
            args.push(format!("--author={}", filter.author.trim()));
        }
        if !filter.text.trim().is_empty() {
            args.push("--fixed-strings".into());
            args.push(format!("--grep={}", filter.text.trim()));
        }
        if !filter.since.trim().is_empty() {
            args.push(format!("--since={}", filter.since.trim()));
        }
        args.push("--".into());
        if !filter.path.trim().is_empty() {
            args.push(filter.path.trim().to_string());
        }
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        let raw = self.git(&argv)?;
        Ok(String::from_utf8_lossy(&raw).lines().filter_map(unhex).collect())
    }

    pub fn commit_full(&self, oid: &str) -> Result<CommitFull> {
        let raw = self.git(&["show", "-s", "-z", "--format=%H%x00%P%x00%s%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%b", oid])?;
        let text = String::from_utf8_lossy(&raw);
        let f: Vec<&str> = text.splitn(10, '\0').collect();
        if f.len() < 10 {
            return Err(GitError("unexpected git show output".into()));
        }
        Ok(CommitFull {
            oid: f[0].to_string(),
            parents: f[1].split_whitespace().map(String::from).collect(),
            subject: f[2].to_string(),
            author: f[3].to_string(),
            author_email: f[4].to_string(),
            author_time: f[5].parse().unwrap_or(0),
            committer: f[6].to_string(),
            committer_email: f[7].to_string(),
            commit_time: f[8].parse().unwrap_or(0),
            body: f[9].trim_end_matches('\0').trim_end().to_string(),
        })
    }

    /// Resolves a hash prefix, ref name or revision expression to a commit oid.
    pub fn resolve(&self, query: &str) -> Option<String> {
        let q = query.trim();
        if q.is_empty() || q.starts_with('-') {
            return None;
        }
        let raw = self.git(&["rev-parse", "--verify", "--quiet", "--end-of-options", &format!("{q}^{{commit}}")]).ok()?;
        let s = String::from_utf8_lossy(&raw).trim().to_string();
        (!s.is_empty()).then_some(s)
    }

    /// Fetches all remotes. It does not change local branches or the working tree.
    pub fn fetch(&self) -> Result<String> {
        let out = Command::new("git")
            .arg("-C")
            .arg(&self.root)
            .args(["fetch", "--all", "--prune"])
            .env("GIT_TERMINAL_PROMPT", "0")
            .envs(network_env())
            .output()
            .map_err(|e| GitError(format!("cannot run git: {e}")))?;
        let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if out.status.success() {
            Ok(msg)
        } else {
            Err(GitError(msg))
        }
    }
}

fn ref_info(full: &str, head: Option<&str>) -> RefInfo {
    if let Some(n) = full.strip_prefix("refs/heads/") {
        let kind = if Some(full) == head {
            RefKind::CurrentBranch
        } else if n == "master" || n == "main" {
            RefKind::Master
        } else {
            RefKind::LocalBranch
        };
        return RefInfo { name: n.to_string(), kind };
    }
    if let Some(n) = full.strip_prefix("refs/remotes/") {
        let kind = if n == "origin/master" || n == "origin/main" { RefKind::OriginMaster } else { RefKind::RemoteBranch };
        return RefInfo { name: n.to_string(), kind };
    }
    if let Some(n) = full.strip_prefix("refs/tags/") {
        return RefInfo { name: n.to_string(), kind: RefKind::Tag };
    }
    RefInfo { name: full.to_string(), kind: RefKind::Other }
}

pub fn parse_name_status(raw: &[u8]) -> Vec<Change> {
    let parts: Vec<String> =
        raw.split(|&b| b == 0).filter(|p| !p.is_empty()).map(|p| String::from_utf8_lossy(p).into_owned()).collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < parts.len() {
        let status = parts[i].chars().next().unwrap_or('M');
        if status == 'R' || status == 'C' {
            if i + 2 >= parts.len() {
                break;
            }
            out.push(Change { status, old_path: Some(parts[i + 1].clone()), path: parts[i + 2].clone() });
            i += 3;
        } else {
            if i + 1 >= parts.len() {
                break;
            }
            out.push(Change { status, path: parts[i + 1].clone(), old_path: None });
            i += 2;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_status_with_renames() {
        let raw = b"M\0a.txt\0R087\0old/b.rs\0new/b.rs\0A\0c d.md\0C100\0x\0y\0D\0z\0";
        let c = parse_name_status(raw);
        assert_eq!(c.len(), 5);
        assert_eq!(c[1], Change { status: 'R', path: "new/b.rs".into(), old_path: Some("old/b.rs".into()) });
        assert_eq!(c[2].path, "c d.md");
        assert_eq!(c[3].status, 'C');
        assert_eq!(c[4], Change { status: 'D', path: "z".into(), old_path: None });
    }

    #[test]
    fn ref_kinds() {
        assert_eq!(ref_info("refs/heads/main", Some("refs/heads/dev")).kind, RefKind::Master);
        assert_eq!(ref_info("refs/heads/dev", Some("refs/heads/dev")).kind, RefKind::CurrentBranch);
        assert_eq!(ref_info("refs/remotes/origin/main", None).kind, RefKind::OriginMaster);
        assert_eq!(ref_info("refs/tags/v1", None).kind, RefKind::Tag);
    }
}
