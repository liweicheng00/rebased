//! The graph on screen: the whole graph or a filtered part of it, and the rows that the log draws.

use crate::{err, CollapseArgs, El, FindArgs, FindResult, OidArgs, CommitInfo, Result, Row, RowsArgs, Service, ViewArgs, ViewResult};
use rebased_git::{Repo, Topology};
use rebased_graph::linear::{GraphCommit, PermanentLinearGraph};
use rebased_graph::print::{Direction, PrintElement};
use rebased_graph::{filter, Graph, GraphOptions, Printer};
use std::collections::HashMap;

/// The rows on screen: the whole graph, or a filtered part of it.
pub(crate) struct View {
    pub(crate) graph: Graph,
    pub(crate) printer: Printer,
    /// Full-graph node of each view node; `None` when the view shows every commit.
    pub(crate) nodes: Option<Vec<usize>>,
    pub(crate) index: HashMap<usize, usize>,
}

impl View {
    pub(crate) fn full_node(&self, view_node: usize) -> usize {
        self.nodes.as_ref().map_or(view_node, |n| n[view_node])
    }

    pub(crate) fn view_node(&self, full: usize) -> Option<usize> {
        if self.nodes.is_none() {
            Some(full)
        } else {
            self.index.get(&full).copied()
        }
    }
}

pub(crate) fn build_full(topo: &Topology) -> PermanentLinearGraph {
    let commits: Vec<GraphCommit<[u8; 20]>> =
        topo.oids.iter().zip(&topo.parents).map(|(id, parents)| GraphCommit { id: *id, parents: parents.clone() }).collect();
    PermanentLinearGraph::build(&commits, |_| i32::MIN)
}

pub(crate) fn build_view(repo: &Repo, topo: &Topology, full: &PermanentLinearGraph, args: &ViewArgs) -> Result<View> {
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
    /// Changes the sort, the long-edge mode or the filter without reloading the repository.
    pub fn set_view(&self, args: ViewArgs) -> Result<ViewResult> {
        self.with(|s| {
            let t = std::time::Instant::now();
            s.view = build_view(&s.repo, &s.topo, &s.full, &args)?;
            s.settings = args;
            Ok(Self::result(s, t))
        })
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
