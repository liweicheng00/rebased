//! App state and commands. Every command takes and returns JSON-serializable values.

pub mod askpass;
pub mod history;
pub mod watch;

pub use rebased_git::changelist::{ChangeListOp, LocalChanges, PartialFile};
use rebased_git::remote::{PushInfo, UpdateMode};
use rebased_git::stash::{Stash, StashDetail};
use rebased_git::merge::{MergeSides, Side};
use rebased_git::history::{Blame, HistoryEntry};
use rebased_git::worktree::{RecentBranch, Worktree};
use rebased_git::ops::{OpResult, PlanEntry, RepoState, ResetMode, RewriteRange, UndoAction, UndoMode};
use rebased_git::{BranchInfo, Change, CommitDetails, CommitFull, FileContent, LogFilter, RefLabel, Repo, Rev, Topology};
use rebased_graph::linear::{GraphCommit, PermanentLinearGraph};
use rebased_graph::print::{Direction, PrintElement};
use rebased_graph::{filter, Graph, GraphOptions, Printer};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub type Result<T> = std::result::Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// The rows on screen: the whole graph, or a filtered part of it.
struct View {
    graph: Graph,
    printer: Printer,
    /// Full-graph node of each view node; `None` when the view shows every commit.
    nodes: Option<Vec<usize>>,
    index: HashMap<usize, usize>,
}

impl View {
    fn full_node(&self, view_node: usize) -> usize {
        self.nodes.as_ref().map_or(view_node, |n| n[view_node])
    }

    fn view_node(&self, full: usize) -> Option<usize> {
        if self.nodes.is_none() {
            Some(full)
        } else {
            self.index.get(&full).copied()
        }
    }
}

struct Session {
    repo: Repo,
    topo: Topology,
    full: PermanentLinearGraph,
    settings: ViewArgs,
    view: View,
    details: HashMap<usize, CommitDetails>,
    head_node: Option<usize>,
    /// None when the watcher could not start; the front end then refreshes on focus only.
    watcher: Option<watch::RepoWatcher>,
    history: Arc<history::LocalHistory>,
}

/// The open repositories, one per tab, and the one that the commands use.
#[derive(Default)]
struct Sessions {
    map: HashMap<std::path::PathBuf, Session>,
    active: Option<std::path::PathBuf>,
}

impl Sessions {
    fn active_mut(&mut self) -> Option<&mut Session> {
        let root = self.active.as_ref()?;
        self.map.get_mut(root)
    }
}

#[derive(Default)]
pub struct Service {
    session: Mutex<Sessions>,
    askpass: Option<std::sync::Arc<askpass::Askpass>>,
    history_limits: Mutex<history::Limits>,
}

#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ViewArgs {
    #[serde(default = "yes")]
    pub intelli_sort: bool,
    pub show_long_edges: bool,
    pub filter: LogFilter,
    /// Collapse every linear branch after the graph is built.
    pub collapse_linear: bool,
}

fn yes() -> bool {
    true
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenArgs {
    pub path: String,
    #[serde(flatten)]
    pub view: ViewArgs,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewResult {
    pub root: String,
    pub head: Option<String>,
    pub head_oid: Option<String>,
    pub total_commits: usize,
    pub row_count: usize,
    pub filtered: bool,
    pub collapsed: bool,
    pub recommended_width: usize,
    pub load_ms: u128,
}

/// One drawing element. `k`: n=node, e=edge. `d`: u/d direction. `j`: row an arrow jumps to.
#[derive(Serialize)]
pub struct El {
    pub k: char,
    pub p: usize,
    pub o: usize,
    pub d: char,
    pub a: bool,
    pub t: bool,
    pub s: bool,
    pub c: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub j: Option<usize>,
    /// Rows (upper, lower) of a collapsed fragment; clicking the edge expands it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<[usize; 2]>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub row: usize,
    pub oid: String,
    pub refs: Vec<RefLabel>,
    pub subject: String,
    pub author: String,
    pub author_email: String,
    pub author_time: i64,
    pub is_head: bool,
    pub elements: Vec<El>,
}

#[derive(Deserialize)]
pub struct RowsArgs {
    pub start: usize,
    pub end: usize,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub enum RevSpec {
    Commit(String),
    ParentOf(String),
    Worktree,
}

#[derive(Deserialize)]
pub struct CompareArgs {
    pub left: RevSpec,
    pub right: RevSpec,
}

#[derive(Deserialize)]
pub struct CompareRefsArgs {
    pub left: String,
    pub right: String,
}

#[derive(Serialize)]
pub struct CompareResult {
    pub changes: Vec<Change>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePairArgs {
    pub left: RevSpec,
    pub right: RevSpec,
    pub path: String,
    pub old_path: Option<String>,
}

#[derive(Serialize)]
pub struct FilePair {
    pub left: FileContent,
    pub right: FileContent,
}

#[derive(Deserialize)]
pub struct OidArgs {
    pub oid: String,
}

#[derive(Deserialize)]
pub struct FindArgs {
    pub query: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FindResult {
    pub oid: Option<String>,
    /// Row in the current view; `None` when the commit is hidden by the filter or unknown.
    pub row: Option<usize>,
    /// The new row count when finding the commit expanded a collapsed branch.
    pub row_count: Option<usize>,
}

#[derive(Deserialize)]
pub struct CollapseArgs {
    pub mode: String,
    pub row: Option<usize>,
    pub up: Option<usize>,
    pub down: Option<usize>,
}

/// A write operation.
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Op {
    Checkout { target: String, kind: String },
    CreateBranch { name: String, at: String, checkout: bool },
    CreateTag { name: String, at: String, #[serde(default)] message: String },
    RenameBranch { from: String, to: String },
    DeleteBranch { name: String, force: bool },
    DeleteTag { name: String },
    Merge { rev: String },
    Rebase { onto: String },
    CherryPick { oids: Vec<String> },
    Revert { oids: Vec<String> },
    Reset { to: String, mode: ResetMode },
    Continue,
    Abort,
    MarkResolved { paths: Vec<String> },
    Rewrite { base: String, plan: Vec<PlanEntry>, what: String },
    Undo { actions: Vec<UndoAction> },
    AddWorktree { path: String, branch: String, new_branch: bool, at: String },
    RemoveWorktree { path: String, force: bool },
    PruneWorktrees,
    Commit {
        paths: Vec<String>,
        #[serde(default)]
        unversioned: Vec<String>,
        #[serde(default)]
        partial: Vec<PartialFile>,
        /// Files in more than one changelist: the hunks to commit.
        #[serde(default)]
        hunks: Vec<HunkSelection>,
        message: String,
        /// Add "Signed-off-by" with the committer, as `git commit -s`.
        #[serde(default)]
        sign_off: bool,
        #[serde(default)]
        amend: bool,
    },
    Rollback { paths: Vec<String> },
    AddFiles { paths: Vec<String> },
    DeleteUnversioned { paths: Vec<String> },
    Push { branch: String, remote: String, remote_branch: String, #[serde(default)] force: bool, #[serde(default)] set_upstream: bool, #[serde(default)] tags: bool },
    Update { mode: UpdateMode },
    StashPush { #[serde(default)] message: String, #[serde(default)] paths: Vec<String>, #[serde(default)] include_untracked: bool, #[serde(default)] keep_index: bool },
    StashApply { index: usize, #[serde(default)] pop: bool, #[serde(default)] restore_index: bool },
    StashDrop { index: usize },
    StashBranch { index: usize, branch: String },
    ResolveText { path: String, text: String },
    ResolveSide { paths: Vec<String>, side: Side },
    ApplyFileChanges { from: String, to: String, paths: Vec<String>, #[serde(default)] reverse: bool },
    GetFromRevision { rev: String, paths: Vec<String> },
    AddRemote { name: String, url: String },
    RemoveRemote { name: String },
    RenameRemote { from: String, to: String },
    SetRemoteUrl { name: String, url: String, #[serde(default)] push_url: String },
    FetchRemote { name: String },
    PushTag { remote: String, tag: String },
    /// Deletes a branch or a tag on a remote; `name` is a full ref.
    DeleteRemoteRef { remote: String, name: String },
    /// Sets the tracked branch; no upstream stops the tracking.
    SetUpstream { branch: String, upstream: Option<String> },
    /// Rolls back the hunks of one changelist of a file that is in more than one changelist.
    RollbackHunks { path: String, ids: Vec<String> },
    /// Initializes the submodules and checks out their recorded commits. No paths means all submodules.
    UpdateSubmodules { #[serde(default)] paths: Vec<String> },
    /// Writes a Local History version back to the working tree. No blob deletes the file.
    RevertLocalHistory { path: String, blob: Option<String> },
}

#[derive(Deserialize)]
pub struct HunkSelection {
    pub path: String,
    pub ids: Vec<String>,
}

/// The files whose local changes an operation can lose, and the Local History label for them.
fn at_risk(repo: &Repo, op: &Op) -> Option<(&'static str, Vec<PathBuf>)> {
    let files = |paths: &[String]| paths.iter().map(PathBuf::from).collect::<Vec<_>>();
    let (label, paths) = match op {
        Op::Rollback { paths } => ("Before Rollback", files(paths)),
        Op::RollbackHunks { path, .. } => ("Before Rollback", files(std::slice::from_ref(path))),
        Op::DeleteUnversioned { paths } => ("Before Delete", files(paths)),
        Op::GetFromRevision { paths, .. } => ("Before Get from Revision", files(paths)),
        Op::ApplyFileChanges { paths, .. } => ("Before Apply Changes", files(paths)),
        Op::ResolveText { path, .. } => ("Before Resolve", files(std::slice::from_ref(path))),
        Op::ResolveSide { paths, .. } => ("Before Resolve", files(paths)),
        Op::StashPush { paths, .. } if !paths.is_empty() => ("Before Stash", files(paths)),
        Op::StashPush { .. } | Op::Reset { mode: ResetMode::Hard, .. } => {
            let label = if matches!(op, Op::StashPush { .. }) { "Before Stash" } else { "Before Hard Reset" };
            let out = repo.git(&["diff", "--name-only", "-z", "HEAD"]).ok()?;
            let changed: Vec<PathBuf> =
                out.split(|&b| b == 0).filter(|p| !p.is_empty()).map(|p| PathBuf::from(String::from_utf8_lossy(p).into_owned())).collect();
            (label, changed)
        }
        _ => return None,
    };
    (!paths.is_empty() && paths.len() <= history::MAX_BULK_FILES * 5).then_some((label, paths))
}

/// What Undo must do for an operation, from the state before it.
enum UndoPlan {
    None,
    /// Move the branch back to the HEAD before the operation.
    MoveBack(UndoMode),
    /// Go back to the branch or commit before; `created` is a local branch that the checkout created.
    Checkout { created: Option<String> },
    CreatedBranch { name: String, checkout: bool },
    CreatedTag { name: String },
    Renamed { from: String, to: String },
    DeletedRef { name: String, oid: String },
    DroppedStash { oid: String, message: String },
}

fn raw_ref(repo: &Repo, name: &str) -> Option<String> {
    repo.git(&["rev-parse", "-q", "--verify", name]).ok().map(|b| String::from_utf8_lossy(&b).trim().to_string()).filter(|s| !s.is_empty())
}

impl UndoPlan {
    fn before(repo: &Repo, op: &Op) -> UndoPlan {
        match op {
            Op::Checkout { target, kind } => {
                let local = target.split_once('/').map_or(target.as_str(), |(_, b)| b);
                let created = (kind == "remote" && raw_ref(repo, &format!("refs/heads/{local}")).is_none()).then(|| local.to_string());
                UndoPlan::Checkout { created }
            }
            Op::CreateBranch { name, checkout, .. } => UndoPlan::CreatedBranch { name: name.clone(), checkout: *checkout },
            Op::CreateTag { name, .. } => UndoPlan::CreatedTag { name: name.clone() },
            Op::RenameBranch { from, to } => UndoPlan::Renamed { from: from.clone(), to: to.clone() },
            Op::DeleteBranch { name, .. } | Op::DeleteTag { name } => {
                let full = if matches!(op, Op::DeleteTag { .. }) { format!("refs/tags/{name}") } else { format!("refs/heads/{name}") };
                // A tag keeps its tag object, so an annotated tag comes back with its message.
                raw_ref(repo, &full).map_or(UndoPlan::None, |oid| UndoPlan::DeletedRef { name: full, oid })
            }
            Op::Merge { .. } | Op::Rebase { .. } | Op::CherryPick { .. } | Op::Revert { .. } | Op::Update { .. } | Op::Continue => {
                UndoPlan::MoveBack(UndoMode::Keep)
            }
            Op::Reset { mode, .. } => UndoPlan::MoveBack(match mode {
                ResetMode::Soft | ResetMode::Mixed => UndoMode::Mixed,
                ResetMode::Hard | ResetMode::Keep => UndoMode::Keep,
            }),
            Op::StashDrop { index } => repo
                .stashes()
                .ok()
                .and_then(|l| l.into_iter().find(|s| s.index == *index))
                .map_or(UndoPlan::None, |s| UndoPlan::DroppedStash { oid: s.oid, message: s.message }),
            _ => UndoPlan::None,
        }
    }

    fn actions(self, repo: &Repo, pre_head: Option<String>, pre_branch: Option<String>) -> Vec<UndoAction> {
        let post = repo.resolve("HEAD").unwrap_or_default();
        let back = || match (&pre_branch, &pre_head) {
            (Some(b), _) => Some(UndoAction::Checkout { target: b.clone(), detach: false, expected_head: post.clone() }),
            (None, Some(h)) => Some(UndoAction::Checkout { target: h.clone(), detach: true, expected_head: post.clone() }),
            _ => None,
        };
        let delete = |full: String| raw_ref(repo, &full).map(|expected| UndoAction::DeleteRef { name: full, expected });
        match self {
            UndoPlan::None => Vec::new(),
            UndoPlan::MoveBack(mode) => match pre_head {
                Some(h) if h != post && !post.is_empty() => vec![UndoAction::Reset { to: h, expected_head: post, mode }],
                _ => Vec::new(),
            },
            UndoPlan::Checkout { created } => {
                back().into_iter().chain(created.and_then(|c| delete(format!("refs/heads/{c}")))).collect()
            }
            UndoPlan::CreatedBranch { name, checkout } => {
                let first = if checkout { back() } else { None };
                first.into_iter().chain(delete(format!("refs/heads/{name}"))).collect()
            }
            UndoPlan::CreatedTag { name } => delete(format!("refs/tags/{name}")).into_iter().collect(),
            UndoPlan::Renamed { from, to } => vec![UndoAction::RenameBranch { from: to, to: from }],
            UndoPlan::DeletedRef { name, oid } => vec![UndoAction::CreateRef { name, oid }],
            UndoPlan::DroppedStash { oid, message } => vec![UndoAction::StashStore { oid, message }],
        }
    }
}

#[derive(Deserialize)]
pub struct PathArgs {
    pub path: String,
}

#[derive(Deserialize)]
pub struct BlobArgs {
    pub blob: Option<String>,
}

#[derive(Deserialize)]
pub struct BlameArgs {
    pub path: String,
    pub rev: RevSpec,
}

#[derive(Deserialize)]
pub struct IndexArgs {
    pub index: usize,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct PushInfoArgs {
    pub branch: Option<String>,
}

#[derive(Serialize)]
pub struct OpOutcome {
    pub result: OpResult,
    pub view: ViewResult,
    pub head: Option<String>,
    /// Submodules whose checked-out commit is not the recorded commit after an operation that moved HEAD.
    #[serde(rename = "staleSubmodules")]
    pub stale_submodules: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    #[serde(flatten)]
    pub commit: CommitFull,
    pub refs: Vec<RefLabel>,
}

fn build_full(topo: &Topology) -> PermanentLinearGraph {
    let commits: Vec<GraphCommit<[u8; 20]>> =
        topo.oids.iter().zip(&topo.parents).map(|(id, parents)| GraphCommit { id: *id, parents: parents.clone() }).collect();
    PermanentLinearGraph::build(&commits, |_| i32::MIN)
}

fn build_view(repo: &Repo, topo: &Topology, full: &PermanentLinearGraph, args: &ViewArgs) -> Result<View> {
    let options = GraphOptions { intelli_sort: args.intelli_sort, show_long_edges: args.show_long_edges };
    let f = &args.filter;
    if f.is_empty() {
        let mut graph = repo.build_graph(topo, &options);
        if args.collapse_linear {
            graph.collapse_all();
        }
        let printer = graph.printer();
        return Ok(View { graph, printer, nodes: None, index: HashMap::new() });
    }
    let n = topo.oids.len();
    let mut visible = vec![true; n];
    if !f.branches.is_empty() {
        // Commits reachable from the chosen refs.
        let mut reach = vec![false; n];
        let mut stack: Vec<usize> =
            f.branches.iter().filter_map(|b| repo.resolve(b)).filter_map(|oid| topo.node_of(&oid)).collect();
        while let Some(node) = stack.pop() {
            if reach[node] {
                continue;
            }
            reach[node] = true;
            full.for_each_parent(node, |p| {
                if p >= 0 && !reach[p as usize] {
                    stack.push(p as usize);
                }
            });
        }
        visible = reach;
    }
    if f.needs_git() {
        let matching = repo.matching_commits(f, &f.branches).map_err(err)?;
        for (i, v) in visible.iter_mut().enumerate() {
            *v = *v && matching.contains(&topo.oids[i]);
        }
    }
    let filtered = filter::filter(full, &visible);
    let index: HashMap<usize, usize> = filtered.nodes.iter().enumerate().map(|(i, &n)| (n, i)).collect();
    let commits: Vec<GraphCommit<usize>> = filtered
        .nodes
        .iter()
        .zip(&filtered.parents)
        .map(|(&id, ps)| GraphCommit { id, parents: ps.iter().map(|p| p.0).collect() })
        .collect();
    let timestamps: Vec<i64> = filtered.nodes.iter().map(|&i| topo.timestamps[i]).collect();
    let refs: Vec<_> = filtered.nodes.iter().map(|&i| topo.refs[i].clone()).collect();
    let mut graph = Graph::build(&commits, &timestamps, &refs, &options);
    graph.set_dotted(filtered.nodes.iter().zip(&filtered.parents).flat_map(|(&child, ps)| {
        let index = &index;
        ps.iter().filter(|p| p.1).map(move |p| (index[&child], index[&p.0]))
    }));
    if args.collapse_linear {
        graph.collapse_all();
    }
    let printer = graph.printer();
    Ok(View { graph, printer, nodes: Some(filtered.nodes), index })
}

impl Service {
    /// A service whose git commands ask for credentials through `helper`, the executable of the app. The
    /// executable must call [`askpass::run_helper_if_requested`] first in `main`.
    pub fn with_askpass(helper: &Path) -> Service {
        Service { askpass: askpass::Askpass::start(helper).ok(), ..Service::default() }
    }

    pub fn askpass_pending(&self) -> Vec<askpass::Prompt> {
        self.askpass.as_ref().map(|a| a.pending()).unwrap_or_default()
    }

    pub fn askpass_answer(&self, a: askpass::Answer) {
        if let Some(p) = &self.askpass {
            p.answer(a);
        }
    }

    pub fn open(&self, args: OpenArgs) -> Result<ViewResult> {
        let repo = Repo::open(Path::new(&args.path)).map_err(err)?;
        self.load(repo, args.view, false)
    }

    /// Sets the git program for all repositories and returns its version. Empty means `git` from PATH.
    pub fn set_git_program(&self, args: PathArgs) -> Result<String> {
        rebased_git::set_git_program(&args.path).map_err(err)
    }

    /// Makes an open repository the active one, for a tab switch. A repository that is not open yet is
    /// opened.
    pub fn activate(&self, args: OpenArgs) -> Result<ViewResult> {
        let repo = Repo::open(Path::new(&args.path)).map_err(err)?;
        {
            let mut sessions = self.session.lock().unwrap();
            if let Some(s) = sessions.map.get_mut(&repo.root) {
                let result = Self::result(s, std::time::Instant::now());
                sessions.active = Some(repo.root);
                return Ok(result);
            }
        }
        self.load(repo, args.view, false)
    }

    /// Closes the tab of a repository: its watcher stops and its memory is freed.
    pub fn close(&self, args: PathArgs) -> Result<()> {
        let root = Repo::open(Path::new(&args.path)).map(|r| r.root).unwrap_or_else(|_| args.path.into());
        let mut sessions = self.session.lock().unwrap();
        sessions.map.remove(&root);
        if sessions.active.as_ref() == Some(&root) {
            sessions.active = None;
        }
        Ok(())
    }

    /// Loads the repository. A refresh (`keep`) keeps the watcher and Local History of the same
    /// repository. An open starts them again, because the directory can be new at the same path.
    fn load(&self, repo: Repo, settings: ViewArgs, keep: bool) -> Result<ViewResult> {
        let t = std::time::Instant::now();
        let topo = repo.load_topology().map_err(err)?;
        let full = build_full(&topo);
        let view = build_view(&repo, &topo, &full, &settings)?;
        let head_node = repo.resolve("HEAD").and_then(|o| topo.node_of(&o));
        // The old session stays until the new one replaces it, so concurrent commands never see
        // "no repository".
        let (kept, history) = match self.session.lock().unwrap().map.get_mut(&repo.root) {
            Some(o) if keep => (o.watcher.take(), Some(o.history.clone())),
            _ => (None, None),
        };
        let history = history
            .unwrap_or_else(|| Arc::new(history::LocalHistory::open(&repo.root, &repo.git_dir(), *self.history_limits.lock().unwrap())));
        let watcher =
            kept.or_else(|| watch::RepoWatcher::start(&repo.root, &repo.git_dir(), &repo.common_dir(), Some(history.clone())).ok());
        let mut s = Session { repo, topo, full, settings, view, details: HashMap::new(), head_node, watcher, history };
        let result = Self::result(&mut s, t);
        let mut sessions = self.session.lock().unwrap();
        // A refresh of a tab that is not active any more must not change the active tab.
        if !keep {
            sessions.active = Some(s.repo.root.clone());
        }
        sessions.map.insert(s.repo.root.clone(), s);
        Ok(result)
    }

    fn result(s: &mut Session, t: std::time::Instant) -> ViewResult {
        let head_oid = s.head_node.map(|n| s.topo.oid_hex(n));
        ViewResult {
            root: s.repo.root.display().to_string(),
            head: s.topo.head.clone(),
            head_oid,
            total_commits: s.topo.oids.len(),
            row_count: s.view.graph.row_count(),
            filtered: s.view.nodes.is_some(),
            collapsed: s.view.graph.has_collapsed(),
            recommended_width: s.view.printer.recommended_width(),
            load_ms: t.elapsed().as_millis(),
        }
    }

    fn with<T>(&self, f: impl FnOnce(&mut Session) -> Result<T>) -> Result<T> {
        let mut guard = self.session.lock().unwrap();
        let s = guard.active_mut().ok_or("no repository is open")?;
        f(s)
    }

    /// Changes the sort, the long-edge mode or the filter without reloading the repository.
    pub fn set_view(&self, args: ViewArgs) -> Result<ViewResult> {
        self.with(|s| {
            let t = std::time::Instant::now();
            s.view = build_view(&s.repo, &s.topo, &s.full, &args)?;
            s.settings = args;
            Ok(Self::result(s, t))
        })
    }

    /// Reloads commits and refs from disk and keeps the current view settings.
    pub fn refresh(&self) -> Result<ViewResult> {
        let (root, settings) = self.with(|s| Ok((s.repo.root.clone(), s.settings.clone())))?;
        self.load(Repo::open(&root).map_err(err)?, settings, true)
    }

    pub fn fetch(&self) -> Result<ViewResult> {
        let root = self.with(|s| Ok(s.repo.root.clone()))?;
        Repo::open(&root).map_err(err)?.fetch().map_err(err)?;
        self.refresh()
    }

    pub fn refs(&self) -> Result<Vec<BranchInfo>> {
        self.with(|s| s.repo.list_refs().map_err(err))
    }

    pub fn rows(&self, args: RowsArgs) -> Result<Vec<Row>> {
        self.with(|s| {
            let end = args.end.min(s.view.graph.row_count());
            let start = args.start.min(end);
            let nodes: Vec<usize> = (start..end).map(|r| s.view.full_node(s.view.graph.node_at_row(r))).collect();
            let missing: Vec<String> = nodes.iter().filter(|n| !s.details.contains_key(n)).map(|&n| s.topo.oid_hex(n)).collect();
            if !missing.is_empty() {
                if s.details.len() > 20_000 {
                    s.details.clear();
                }
                for d in s.repo.commit_details(&missing).map_err(err)? {
                    if let Some(n) = s.topo.node_of(&d.oid) {
                        s.details.insert(n, d);
                    }
                }
            }
            let head = s.head_node;
            Ok((start..end)
                .zip(nodes)
                .map(|(row, node)| {
                    let d = s.details.get(&node);
                    Row {
                        row,
                        oid: s.topo.oid_hex(node),
                        refs: s.topo.ref_labels(node),
                        subject: d.map(|d| d.subject.clone()).unwrap_or_default(),
                        author: d.map(|d| d.author.clone()).unwrap_or_default(),
                        author_email: d.map(|d| d.author_email.clone()).unwrap_or_default(),
                        author_time: d.map(|d| d.author_time).unwrap_or(0),
                        is_head: Some(node) == head,
                        elements: s.view.printer.print_elements(row).iter().map(|e| el(&s.view.graph, e)).collect(),
                    }
                })
                .collect())
        })
    }

    pub fn commit(&self, args: OidArgs) -> Result<CommitInfo> {
        self.with(|s| {
            let commit = s.repo.commit_full(&args.oid).map_err(err)?;
            let refs = s.topo.node_of(&commit.oid).map(|n| s.topo.ref_labels(n)).unwrap_or_default();
            Ok(CommitInfo { commit, refs })
        })
    }

    pub fn find(&self, args: FindArgs) -> Result<FindResult> {
        self.with(|s| {
            let Some(oid) = s.repo.resolve(&args.query) else { return Ok(FindResult { oid: None, row: None, row_count: None }) };
            let Some(view_node) = s.topo.node_of(&oid).and_then(|n| s.view.view_node(n)) else {
                return Ok(FindResult { oid: Some(oid), row: None, row_count: None });
            };
            if let Some(row) = s.view.graph.row_of_node(view_node) {
                return Ok(FindResult { oid: Some(oid), row: Some(row), row_count: None });
            }
            // A collapsed fragment hides the commit: expand it.
            let row = s.view.graph.reveal_node(view_node);
            s.view.printer = s.view.graph.printer();
            Ok(FindResult { oid: Some(oid), row: Some(row), row_count: Some(s.view.graph.row_count()) })
        })
    }

    /// Collapses or expands linear branches. `all`: collapse all; `none`: expand all; or one fragment at `row`,
    /// or the collapsed edge `up`..`down`.
    pub fn collapse(&self, args: CollapseArgs) -> Result<ViewResult> {
        self.with(|s| {
            let t = std::time::Instant::now();
            match args.mode.as_str() {
                "all" => s.view.graph.collapse_all(),
                "none" => s.view.graph.expand_all(),
                "row" => {
                    if !s.view.graph.collapse_at(args.row.unwrap_or(0)) {
                        return Err("There is no linear branch to collapse here".into());
                    }
                }
                "edge" => {
                    let (u, d) = (args.up.unwrap_or(0), args.down.unwrap_or(0));
                    if !s.view.graph.expand_edge(u, d) {
                        return Err("This edge is not a collapsed branch".into());
                    }
                }
                m => return Err(format!("unknown collapse mode {m}")),
            }
            s.settings.collapse_linear = args.mode == "all";
            s.view.printer = s.view.graph.printer();
            Ok(Self::result(s, t))
        })
    }

    pub fn worktrees(&self) -> Result<Vec<Worktree>> {
        self.with(|s| s.repo.worktrees().map_err(err))
    }

    pub fn recent_branches(&self) -> Result<Vec<RecentBranch>> {
        self.with(|s| s.repo.recent_branches(10).map_err(err))
    }

    pub fn local_changes(&self) -> Result<LocalChanges> {
        self.with(|s| s.repo.local_changes().map_err(err))
    }

    /// Changes the changelists and returns the new local changes.
    pub fn changelist_op(&self, op: ChangeListOp) -> Result<LocalChanges> {
        self.with(|s| {
            s.repo.changelist_op(op).map_err(err)?;
            s.repo.local_changes().map_err(err)
        })
    }

    pub fn push_info(&self, args: PushInfoArgs) -> Result<PushInfo> {
        self.with(|s| s.repo.push_info(args.branch.as_deref()).map_err(err))
    }

    pub fn stashes(&self) -> Result<Vec<Stash>> {
        self.with(|s| s.repo.stashes().map_err(err))
    }

    pub fn stash_detail(&self, args: IndexArgs) -> Result<StashDetail> {
        self.with(|s| s.repo.stash_detail(args.index).map_err(err))
    }

    pub fn merge_sides(&self, args: PathArgs) -> Result<MergeSides> {
        self.with(|s| s.repo.merge_sides(&args.path).map_err(err))
    }

    pub fn file_history(&self, args: PathArgs) -> Result<Vec<HistoryEntry>> {
        self.with(|s| s.repo.file_history(&args.path).map_err(err))
    }

    pub fn blame(&self, args: BlameArgs) -> Result<Blame> {
        self.with(|s| {
            let rev = match Self::rev(&s.repo, &args.rev)? {
                Rev::Commit(o) => Some(o),
                Rev::WorkTree => None,
                Rev::EmptyTree => return Err("The file does not exist in this revision".into()),
            };
            s.repo.blame(rev.as_deref(), &args.path).map_err(err)
        })
    }

    /// Counters that go up when the repository or its files change outside the app.
    pub fn watch_state(&self) -> Result<Option<watch::WatchCounters>> {
        self.with(|s| Ok(s.watcher.as_ref().map(|w| w.state.counters())))
    }

    /// The Local History versions of a file or a directory, or of all files when the path is empty.
    pub fn local_history(&self, args: PathArgs) -> Result<Vec<history::Revision>> {
        self.with(|s| Ok(s.history.revisions(Some(args.path.as_str()).filter(|p| !p.is_empty()), 2000)))
    }

    pub fn local_history_content(&self, args: BlobArgs) -> Result<history::Content> {
        self.with(|s| Ok(s.history.content(args.blob.as_deref())))
    }

    pub fn set_local_history_limits(&self, limits: history::Limits) -> Result<()> {
        *self.history_limits.lock().unwrap() = limits;
        for s in self.session.lock().unwrap().map.values() {
            s.history.set_limits(limits);
        }
        Ok(())
    }

    pub fn commit_template(&self) -> Result<Option<String>> {
        self.with(|s| Ok(s.repo.commit_template()))
    }

    pub fn remotes(&self) -> Result<Vec<rebased_git::remote::RemoteInfo>> {
        self.with(|s| s.repo.remote_details().map_err(err))
    }

    pub fn submodules(&self) -> Result<Vec<rebased_git::submodule::Submodule>> {
        self.with(|s| s.repo.submodules().map_err(err))
    }

    pub fn head_message(&self) -> Result<String> {
        self.with(|s| s.repo.head_message().map_err(err))
    }

    pub fn state(&self) -> Result<RepoState> {
        self.with(|s| s.repo.state().map_err(err))
    }

    pub fn rewrite_range(&self, args: OidArgs) -> Result<RewriteRange> {
        self.with(|s| s.repo.rewrite_range(&args.oid).map_err(err))
    }

    /// Runs a write operation, then reloads commits and refs. A failed operation still reloads,
    /// because git can stop halfway (for example at a conflict).
    pub fn run_op(&self, op: Op) -> Result<OpOutcome> {
        let (root, history) = self.with(|s| Ok((s.repo.root.clone(), s.history.clone())))?;
        let repo = Repo::open(&root).map_err(err)?;
        if let Some((label, paths)) = at_risk(&repo, &op) {
            history.record(&paths, label);
        }
        let plan = UndoPlan::before(&repo, &op);
        let pre_head = repo.resolve("HEAD");
        let pre_branch = repo.state().ok().and_then(|s| s.branch);
        // Operations that can change the recorded commit of a submodule without checking it out.
        let moves_head = matches!(
            op,
            Op::Checkout { .. }
                | Op::CreateBranch { checkout: true, .. }
                | Op::Merge { .. }
                | Op::Rebase { .. }
                | Op::CherryPick { .. }
                | Op::Revert { .. }
                | Op::Reset { .. }
                | Op::Continue
                | Op::Abort
                | Op::Undo { .. }
                | Op::Update { .. }
        );
        let result = match op {
            Op::Checkout { target, kind } => repo.checkout(&target, &kind),
            Op::CreateBranch { name, at, checkout } => repo.create_branch(&name, &at, checkout),
            Op::CreateTag { name, at, message } => repo.create_tag(&name, &at, &message),
            Op::RenameBranch { from, to } => repo.rename_branch(&from, &to),
            Op::DeleteBranch { name, force } => repo.delete_branch(&name, force),
            Op::DeleteTag { name } => repo.delete_tag(&name),
            Op::Merge { rev } => repo.merge(&rev),
            Op::Rebase { onto } => repo.rebase(&onto),
            Op::CherryPick { oids } => repo.cherry_pick(&oids),
            Op::Revert { oids } => repo.revert(&oids),
            Op::Reset { to, mode } => repo.reset(&to, mode),
            Op::Continue => repo.continue_or_abort(false),
            Op::Abort => repo.continue_or_abort(true),
            Op::MarkResolved { paths } => repo.mark_resolved(&paths),
            Op::Rewrite { base, plan, what } => repo.rewrite(&base, &plan, &what),
            Op::Undo { actions } => repo.apply_undo(&actions),
            Op::AddWorktree { path, branch, new_branch, at } => {
                repo.add_worktree(&path, &branch, new_branch, &at).map(|_| OpResult::ok_msg(format!("Added worktree {path}")))
            }
            Op::RemoveWorktree { path, force } => {
                repo.remove_worktree(&path, force).map(|_| OpResult::ok_msg(format!("Removed worktree {path}")))
            }
            Op::PruneWorktrees => repo.prune_worktrees().map(|_| OpResult::ok_msg("Pruned stale worktrees")),
            Op::Commit { paths, unversioned, mut partial, hunks, message, sign_off, amend } => {
                let message = if sign_off { repo.with_sign_off(&message).map_err(err)? } else { message };
                for h in hunks {
                    let content = repo.content_with_hunks(&h.path, &h.ids).map_err(err)?;
                    partial.push(PartialFile { path: h.path, content });
                }
                if partial.is_empty() {
                    repo.commit_paths(&paths, &unversioned, &message, amend)
                } else {
                    repo.commit_partial(&paths, &unversioned, &partial, &message, amend)
                }
            }
            Op::Rollback { paths } => repo.rollback(&paths),
            Op::AddFiles { paths } => repo.add_files(&paths),
            Op::DeleteUnversioned { paths } => repo.delete_unversioned(&paths),
            Op::Push { branch, remote, remote_branch, force, set_upstream, tags } => {
                repo.push(&branch, &remote, &remote_branch, force, set_upstream, tags)
            }
            Op::Update { mode } => repo.update(mode),
            Op::StashPush { message, paths, include_untracked, keep_index } => repo.stash_push(&message, &paths, include_untracked, keep_index),
            Op::StashApply { index, pop, restore_index } => repo.stash_apply(index, pop, restore_index),
            Op::StashDrop { index } => repo.stash_drop(index),
            Op::StashBranch { index, branch } => repo.stash_branch(index, &branch),
            Op::ResolveText { path, text } => repo.resolve_with_text(&path, &text),
            Op::ResolveSide { paths, side } => repo.resolve_with_side(&paths, side),
            Op::ApplyFileChanges { from, to, paths, reverse } => repo.apply_file_changes(&from, &to, &paths, reverse),
            Op::GetFromRevision { rev, paths } => repo.get_from_revision(&rev, &paths),
            Op::UpdateSubmodules { paths } => repo.update_submodules(&paths),
            Op::AddRemote { name, url } => repo.add_remote(&name, &url),
            Op::RemoveRemote { name } => repo.remove_remote(&name),
            Op::RenameRemote { from, to } => repo.rename_remote(&from, &to),
            Op::SetRemoteUrl { name, url, push_url } => repo.set_remote_url(&name, &url, &push_url),
            Op::FetchRemote { name } => repo.fetch_remote(&name),
            Op::PushTag { remote, tag } => repo.push_tag(&remote, &tag),
            Op::DeleteRemoteRef { remote, name } => repo.delete_remote_ref(&remote, &name),
            Op::SetUpstream { branch, upstream } => repo.set_upstream(&branch, upstream.as_deref()),
            Op::RollbackHunks { path, ids } => repo.rollback_hunks(&path, &ids),
            Op::RevertLocalHistory { path, blob } => history
                .revert(&path, blob.as_deref())
                .map(|_| OpResult::ok_msg(format!("Reverted {path} to the Local History version")))
                .map_err(rebased_git::GitError),
        };
        let mut result = match result {
            Ok(r) => r,
            Err(e) => OpResult { ok: false, message: e.to_string(), conflicts: Vec::new(), undo: Vec::new() },
        };
        if result.ok && result.undo.is_empty() {
            result.undo = plan.actions(&repo, pre_head.clone(), pre_branch);
        }
        let view = self.refresh()?;
        let head = view.head_oid.clone();
        let stale_submodules = if moves_head && head != pre_head {
            repo.submodules()
                .unwrap_or_default()
                .into_iter()
                .filter(|s| s.state == rebased_git::submodule::SubmoduleState::OtherCommit && !s.dirty)
                .map(|s| s.path)
                .collect()
        } else {
            Vec::new()
        };
        Ok(OpOutcome { result, view, head, stale_submodules })
    }

    fn rev(repo: &Repo, spec: &RevSpec) -> Result<Rev> {
        match spec {
            RevSpec::Commit(o) => Ok(Rev::Commit(o.clone())),
            RevSpec::ParentOf(o) => repo.first_parent(o).map_err(err),
            RevSpec::Worktree => Ok(Rev::WorkTree),
        }
    }

    /// The commits that each of two refs has and the other has not.
    pub fn compare_refs(&self, args: CompareRefsArgs) -> Result<rebased_git::remote::RefComparison> {
        self.with(|s| s.repo.compare_refs(&args.left, &args.right).map_err(err))
    }

    pub fn compare(&self, args: CompareArgs) -> Result<CompareResult> {
        self.with(|s| {
            let (l, r) = (Self::rev(&s.repo, &args.left)?, Self::rev(&s.repo, &args.right)?);
            Ok(CompareResult { changes: s.repo.list_changes(&l, &r).map_err(err)? })
        })
    }

    pub fn file_pair(&self, args: FilePairArgs) -> Result<FilePair> {
        self.with(|s| {
            let (l, r) = (Self::rev(&s.repo, &args.left)?, Self::rev(&s.repo, &args.right)?);
            let left_path = args.old_path.as_deref().unwrap_or(&args.path);
            Ok(FilePair {
                left: s.repo.file_content(&l, left_path).map_err(err)?,
                right: s.repo.file_content(&r, &args.path).map_err(err)?,
            })
        })
    }

    /// Dispatches a command by name; used by the dev server.
    pub fn dispatch(&self, cmd: &str, body: &str) -> Result<String> {
        fn parse<T: for<'de> Deserialize<'de>>(b: &str) -> Result<T> {
            serde_json::from_str(if b.trim().is_empty() { "{}" } else { b }).map_err(err)
        }
        let out = match cmd {
            "open" => serde_json::to_string(&self.open(parse(body)?)?),
            "set_view" => serde_json::to_string(&self.set_view(parse(body)?)?),
            "refresh" => serde_json::to_string(&self.refresh()?),
            "set_git_program" => serde_json::to_string(&self.set_git_program(parse(body)?)?),
            "activate" => serde_json::to_string(&self.activate(parse(body)?)?),
            "close" => serde_json::to_string(&self.close(parse(body)?)?),
            "fetch" => serde_json::to_string(&self.fetch()?),
            "refs" => serde_json::to_string(&self.refs()?),
            "rows" => serde_json::to_string(&self.rows(parse(body)?)?),
            "commit" => serde_json::to_string(&self.commit(parse(body)?)?),
            "find" => serde_json::to_string(&self.find(parse(body)?)?),
            "collapse" => serde_json::to_string(&self.collapse(parse(body)?)?),
            "local_changes" => serde_json::to_string(&self.local_changes()?),
            "changelist_op" => serde_json::to_string(&self.changelist_op(parse(body)?)?),
            "push_info" => serde_json::to_string(&self.push_info(parse(body)?)?),
            "stashes" => serde_json::to_string(&self.stashes()?),
            "stash_detail" => serde_json::to_string(&self.stash_detail(parse(body)?)?),
            "merge_sides" => serde_json::to_string(&self.merge_sides(parse(body)?)?),
            "file_history" => serde_json::to_string(&self.file_history(parse(body)?)?),
            "blame" => serde_json::to_string(&self.blame(parse(body)?)?),
            "watch_state" => serde_json::to_string(&self.watch_state()?),
            "askpass_pending" => serde_json::to_string(&self.askpass_pending()),
            "askpass_answer" => {
                self.askpass_answer(parse(body)?);
                Ok("null".to_string())
            }
            "head_message" => serde_json::to_string(&self.head_message()?),
            "submodules" => serde_json::to_string(&self.submodules()?),
            "remotes" => serde_json::to_string(&self.remotes()?),
            "commit_template" => serde_json::to_string(&self.commit_template()?),
            "local_history" => serde_json::to_string(&self.local_history(parse(body)?)?),
            "local_history_content" => serde_json::to_string(&self.local_history_content(parse(body)?)?),
            "set_local_history_limits" => serde_json::to_string(&self.set_local_history_limits(parse(body)?)?),
            "repo_state" => serde_json::to_string(&self.state()?),
            "worktrees" => serde_json::to_string(&self.worktrees()?),
            "recent_branches" => serde_json::to_string(&self.recent_branches()?),
            "rewrite_range" => serde_json::to_string(&self.rewrite_range(parse(body)?)?),
            "run_op" => serde_json::to_string(&self.run_op(parse(body)?)?),
            "compare" => serde_json::to_string(&self.compare(parse(body)?)?),
            "compare_refs" => serde_json::to_string(&self.compare_refs(parse(body)?)?),
            "file_pair" => serde_json::to_string(&self.file_pair(parse(body)?)?),
            _ => return Err(format!("unknown command {cmd}")),
        };
        out.map_err(err)
    }
}

fn el(graph: &Graph, e: &PrintElement) -> El {
    let c = graph.element_color(e);
    match *e {
        PrintElement::Node { pos, .. } => El { k: 'n', p: pos, o: pos, d: 'd', a: false, t: false, s: false, c, j: None, x: None },
        PrintElement::Edge { pos, other_pos, dir, arrow, terminal, edge, .. } => El {
            k: 'e',
            p: pos,
            o: other_pos,
            d: if dir == Direction::Up { 'u' } else { 'd' },
            a: arrow,
            t: terminal,
            s: graph.is_edge_dashed(&edge),
            c,
            j: if arrow { if dir == Direction::Up { edge.up } else { edge.down } } else { None },
            x: if graph.is_collapsed_edge(&edge) { edge.up.zip(edge.down).map(|(u, d)| [u, d]) } else { None },
        },
    }
}
