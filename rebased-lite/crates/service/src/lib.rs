//! App state and commands. Every command takes and returns JSON-serializable values.

use rebased_git::{BranchInfo, Change, CommitDetails, CommitFull, FileContent, LogFilter, RefLabel, Repo, Rev, Topology};
use rebased_graph::linear::{GraphCommit, PermanentLinearGraph};
use rebased_graph::print::{Direction, PrintElement};
use rebased_graph::{filter, Graph, GraphOptions, Printer};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

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
}

#[derive(Default)]
pub struct Service {
    session: Mutex<Option<Session>>,
}

#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ViewArgs {
    #[serde(default = "yes")]
    pub intelli_sort: bool,
    pub show_long_edges: bool,
    pub filter: LogFilter,
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
pub struct FindResult {
    pub oid: Option<String>,
    /// Row in the current view; `None` when the commit is hidden by the filter or unknown.
    pub row: Option<usize>,
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
        let graph = repo.build_graph(topo, &options);
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
    let printer = graph.printer();
    Ok(View { graph, printer, nodes: Some(filtered.nodes), index })
}

impl Service {
    pub fn open(&self, args: OpenArgs) -> Result<ViewResult> {
        let repo = Repo::open(Path::new(&args.path)).map_err(err)?;
        self.load(repo, args.view)
    }

    fn load(&self, repo: Repo, settings: ViewArgs) -> Result<ViewResult> {
        let t = std::time::Instant::now();
        let topo = repo.load_topology().map_err(err)?;
        let full = build_full(&topo);
        let view = build_view(&repo, &topo, &full, &settings)?;
        let head_node = repo.resolve("HEAD").and_then(|o| topo.node_of(&o));
        let mut s = Session { repo, topo, full, settings, view, details: HashMap::new(), head_node };
        let result = Self::result(&mut s, t);
        *self.session.lock().unwrap() = Some(s);
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
            recommended_width: s.view.printer.recommended_width(),
            load_ms: t.elapsed().as_millis(),
        }
    }

    fn with<T>(&self, f: impl FnOnce(&mut Session) -> Result<T>) -> Result<T> {
        let mut guard = self.session.lock().unwrap();
        let s = guard.as_mut().ok_or("no repository is open")?;
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
        self.load(Repo::open(&root).map_err(err)?, settings)
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
            let Some(oid) = s.repo.resolve(&args.query) else { return Ok(FindResult { oid: None, row: None }) };
            let row = s.topo.node_of(&oid).and_then(|n| s.view.view_node(n)).map(|v| s.view.graph.row_of_node(v));
            Ok(FindResult { oid: Some(oid), row })
        })
    }

    fn rev(repo: &Repo, spec: &RevSpec) -> Result<Rev> {
        match spec {
            RevSpec::Commit(o) => Ok(Rev::Commit(o.clone())),
            RevSpec::ParentOf(o) => repo.first_parent(o).map_err(err),
            RevSpec::Worktree => Ok(Rev::WorkTree),
        }
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
            "fetch" => serde_json::to_string(&self.fetch()?),
            "refs" => serde_json::to_string(&self.refs()?),
            "rows" => serde_json::to_string(&self.rows(parse(body)?)?),
            "commit" => serde_json::to_string(&self.commit(parse(body)?)?),
            "find" => serde_json::to_string(&self.find(parse(body)?)?),
            "compare" => serde_json::to_string(&self.compare(parse(body)?)?),
            "file_pair" => serde_json::to_string(&self.file_pair(parse(body)?)?),
            _ => return Err(format!("unknown command {cmd}")),
        };
        out.map_err(err)
    }
}

fn el(graph: &Graph, e: &PrintElement) -> El {
    let c = graph.element_color(e);
    match *e {
        PrintElement::Node { pos, .. } => El { k: 'n', p: pos, o: pos, d: 'd', a: false, t: false, s: false, c, j: None },
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
        },
    }
}
