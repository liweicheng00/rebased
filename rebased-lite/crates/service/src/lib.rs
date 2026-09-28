//! App state and commands. Every command takes and returns JSON-serializable values.

use rebased_git::{Change, CommitDetails, FileContent, RefLabel, Repo, Rev, Topology};
use rebased_graph::print::{Direction, PrintElement};
use rebased_graph::{Graph, GraphOptions, Printer};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

pub type Result<T> = std::result::Result<T, String>;

struct Session {
    repo: Repo,
    topo: Topology,
    graph: Graph,
    printer: Printer,
    details: HashMap<usize, CommitDetails>,
}

#[derive(Default)]
pub struct Service {
    session: Mutex<Option<Session>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenArgs {
    pub path: String,
    #[serde(default = "yes")]
    pub intelli_sort: bool,
    #[serde(default)]
    pub show_long_edges: bool,
}

fn yes() -> bool {
    true
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenResult {
    pub root: String,
    pub head: Option<String>,
    pub row_count: usize,
    pub recommended_width: usize,
    pub load_ms: u128,
}

/// One drawing element. `k`: n=node, e=edge. `d`: u/d direction. Compact keys keep row payloads small.
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
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub row: usize,
    pub oid: String,
    pub refs: Vec<RefLabel>,
    pub subject: String,
    pub author: String,
    pub author_time: i64,
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
pub struct DetailsArgs {
    pub oid: String,
}

impl Service {
    pub fn open(&self, args: OpenArgs) -> Result<OpenResult> {
        let t = std::time::Instant::now();
        let repo = Repo::open(Path::new(&args.path)).map_err(|e| e.to_string())?;
        let topo = repo.load_topology().map_err(|e| e.to_string())?;
        let options = GraphOptions { intelli_sort: args.intelli_sort, show_long_edges: args.show_long_edges };
        let graph = repo.build_graph(&topo, &options);
        let printer = graph.printer();
        let result = OpenResult {
            root: repo.root.display().to_string(),
            head: topo.head.clone(),
            row_count: graph.row_count(),
            recommended_width: printer.recommended_width(),
            load_ms: t.elapsed().as_millis(),
        };
        *self.session.lock().unwrap() = Some(Session { repo, topo, graph, printer, details: HashMap::new() });
        Ok(result)
    }

    fn with<T>(&self, f: impl FnOnce(&mut Session) -> Result<T>) -> Result<T> {
        let mut guard = self.session.lock().unwrap();
        let s = guard.as_mut().ok_or("no repository is open")?;
        f(s)
    }

    pub fn rows(&self, args: RowsArgs) -> Result<Vec<Row>> {
        self.with(|s| {
            let end = args.end.min(s.graph.row_count());
            let start = args.start.min(end);
            let nodes: Vec<usize> = (start..end).map(|r| s.graph.node_at_row(r)).collect();
            let missing: Vec<String> = nodes.iter().filter(|n| !s.details.contains_key(n)).map(|&n| s.topo.oid_hex(n)).collect();
            if !missing.is_empty() {
                for d in s.repo.commit_details(&missing).map_err(|e| e.to_string())? {
                    if let Some(n) = s.topo.node_of(&d.oid) {
                        s.details.insert(n, d);
                    }
                }
                if s.details.len() > 20_000 {
                    s.details.clear();
                }
            }
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
                        author_time: d.map(|d| d.author_time).unwrap_or(0),
                        elements: s.printer.print_elements(row).iter().map(|e| el(&s.graph, e)).collect(),
                    }
                })
                .collect())
        })
    }

    pub fn details(&self, args: DetailsArgs) -> Result<CommitDetails> {
        self.with(|s| {
            s.repo.commit_details(&[args.oid]).map_err(|e| e.to_string())?.into_iter().next().ok_or_else(|| "commit not found".into())
        })
    }

    fn rev(repo: &Repo, spec: &RevSpec) -> Result<Rev> {
        match spec {
            RevSpec::Commit(o) => Ok(Rev::Commit(o.clone())),
            RevSpec::ParentOf(o) => repo.first_parent(o).map_err(|e| e.to_string()),
            RevSpec::Worktree => Ok(Rev::WorkTree),
        }
    }

    pub fn compare(&self, args: CompareArgs) -> Result<CompareResult> {
        self.with(|s| {
            let (l, r) = (Self::rev(&s.repo, &args.left)?, Self::rev(&s.repo, &args.right)?);
            Ok(CompareResult { changes: s.repo.list_changes(&l, &r).map_err(|e| e.to_string())? })
        })
    }

    pub fn file_pair(&self, args: FilePairArgs) -> Result<FilePair> {
        self.with(|s| {
            let (l, r) = (Self::rev(&s.repo, &args.left)?, Self::rev(&s.repo, &args.right)?);
            let left_path = args.old_path.as_deref().unwrap_or(&args.path);
            Ok(FilePair {
                left: s.repo.file_content(&l, left_path).map_err(|e| e.to_string())?,
                right: s.repo.file_content(&r, &args.path).map_err(|e| e.to_string())?,
            })
        })
    }

    /// Dispatches a command by name; used by the dev server.
    pub fn dispatch(&self, cmd: &str, body: &str) -> Result<String> {
        fn parse<T: for<'de> Deserialize<'de>>(b: &str) -> Result<T> {
            serde_json::from_str(if b.trim().is_empty() { "{}" } else { b }).map_err(|e| e.to_string())
        }
        let out = match cmd {
            "open" => serde_json::to_string(&self.open(parse(body)?)?),
            "rows" => serde_json::to_string(&self.rows(parse(body)?)?),
            "details" => serde_json::to_string(&self.details(parse(body)?)?),
            "compare" => serde_json::to_string(&self.compare(parse(body)?)?),
            "file_pair" => serde_json::to_string(&self.file_pair(parse(body)?)?),
            _ => return Err(format!("unknown command {cmd}")),
        };
        out.map_err(|e| e.to_string())
    }
}

fn el(graph: &Graph, e: &PrintElement) -> El {
    let c = graph.element_color(e);
    match *e {
        PrintElement::Node { pos, .. } => El { k: 'n', p: pos, o: pos, d: 'd', a: false, t: false, s: false, c },
        PrintElement::Edge { pos, other_pos, dir, arrow, terminal, edge, .. } => El {
            k: 'e',
            p: pos,
            o: other_pos,
            d: if dir == Direction::Up { 'u' } else { 'd' },
            a: arrow,
            t: terminal,
            s: Graph::is_dashed(edge.ty),
            c,
        },
    }
}
