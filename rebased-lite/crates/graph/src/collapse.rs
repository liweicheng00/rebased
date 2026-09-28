// Ported from IntelliJ Community `platform/vcs-log/graph/collapsing` (Apache-2.0):
// LinearFragmentGenerator, FragmentGenerator.getMiddleNodes and the COLLAPSE_ALL, EXPAND_ALL,
// LINEAR_COLLAPSE and LINEAR_EXPAND cases of CollapsedActionManager.
//
// A linear fragment is a closed part of the graph between an upper and a lower node. Collapsing it hides
// the middle nodes and joins its ends with one dotted edge. Rows keep their order.

use crate::linear::{Edge, EdgeFilter, EdgeType, LinearGraph, NodeType};
use std::collections::{BTreeSet, HashSet};
use std::sync::Arc;

const SHORT_FRAGMENT_MAX_SIZE: usize = 10;
const MAX_SEARCH_SIZE: usize = 10;

fn next(g: &impl LinearGraph, node: usize, down: bool) -> Vec<usize> {
    if down {
        g.down_nodes(node)
    } else {
        g.up_nodes(node)
    }
}

/// A short closed fragment that starts at `start` and goes down (or up).
fn fragment(g: &impl LinearGraph, start: usize, down: bool, pinned: &HashSet<usize>) -> Option<(usize, usize)> {
    let mut black: HashSet<usize> = HashSet::from([start]);
    let mut gray: BTreeSet<usize> = next(g, start, down).into_iter().collect();
    let mut end = None;
    while black.len() < SHORT_FRAGMENT_MAX_SIZE {
        let next_black = gray.iter().copied().find(|&n| next(g, n, !down).iter().all(|p| black.contains(p)))?;
        if gray.len() == 1 {
            end = Some(next_black);
            break;
        }
        let next_gray = next(g, next_black, down);
        if next_gray.is_empty() || pinned.contains(&next_black) {
            return None;
        }
        black.insert(next_black);
        gray.remove(&next_black);
        gray.extend(next_gray);
    }
    end.map(|e| if down { (start, e) } else { (e, start) })
}

fn down_fragment(g: &impl LinearGraph, up: usize, pinned: &HashSet<usize>) -> Option<(usize, usize)> {
    fragment(g, up, true, pinned)
}

fn up_fragment(g: &impl LinearGraph, down: usize, pinned: &HashSet<usize>) -> Option<(usize, usize)> {
    fragment(g, down, false, pinned)
}

/// Extends a short fragment up and down through linear parts that do not stop at a pinned (ref) node.
fn long_fragment(g: &impl LinearGraph, start: Option<(usize, usize)>, bound: usize, pinned: &HashSet<usize>) -> Option<(usize, usize)> {
    let (su, sd) = start?;
    let mut max_down = sd;
    while let Some(f) = down_fragment(g, max_down, pinned) {
        if pinned.contains(&max_down) {
            break;
        }
        max_down = f.1;
        if max_down - sd > bound {
            break;
        }
    }
    let mut max_up = su;
    while let Some(f) = up_fragment(g, max_up, pinned) {
        if pinned.contains(&max_up) {
            break;
        }
        max_up = f.0;
        if su - max_up > bound {
            break;
        }
    }
    if max_up != su || max_down != sd {
        Some((max_up, max_down))
    } else if g.down_nodes(su).len() != 1 {
        Some((su, sd))
    } else {
        None
    }
}

/// The fragment around a node or a normal edge, as LinearFragmentGenerator.getRelativeFragment.
fn relative_fragment(g: &impl LinearGraph, up: usize, down: usize, pinned: &HashSet<usize>) -> Option<(usize, usize)> {
    let mut up = up;
    for _ in 0..MAX_SEARCH_SIZE {
        if let Some(f) = down_fragment(g, up, pinned) {
            if f.1 >= down {
                return Some(f);
            }
        }
        let ups = g.up_nodes(up);
        if ups.len() != 1 {
            break;
        }
        up = ups[0];
    }
    None
}

fn walk(g: &impl LinearGraph, start: usize, up: bool, stop: impl Fn(usize) -> bool) -> HashSet<usize> {
    let mut seen = HashSet::new();
    let mut stack = vec![start];
    while let Some(n) = stack.pop() {
        if stop(n) || !seen.insert(n) {
            continue;
        }
        stack.extend(next(g, n, !up));
    }
    seen
}

/// Nodes between `up` and `down` that are reachable from both.
pub fn middle_nodes(g: &impl LinearGraph, up: usize, down: usize, strict: bool) -> Vec<usize> {
    let from_up = walk(g, up, false, |n| n > down);
    let from_down = walk(g, down, true, |n| n < up);
    let mut m: Vec<usize> = from_up.intersection(&from_down).copied().filter(|&n| !strict || (n != up && n != down)).collect();
    m.sort_unstable();
    m
}

/// Which delegate rows are hidden, and the dotted edges (upper row, lower row) that replace them.
#[derive(Clone, Debug, Default)]
pub struct CollapseState {
    pub hidden: Vec<bool>,
    pub dotted: BTreeSet<(usize, usize)>,
}

impl CollapseState {
    pub fn is_empty(&self) -> bool {
        self.dotted.is_empty()
    }

    /// COLLAPSE_ALL: every long linear fragment of the delegate graph, from the top down.
    pub fn collapse_all(g: &impl LinearGraph, pinned: &HashSet<usize>) -> CollapseState {
        let n = g.nodes_count();
        let mut s = CollapseState { hidden: vec![false; n], dotted: BTreeSet::new() };
        for row in 0..n {
            if s.hidden[row] {
                continue;
            }
            if let Some((up, down)) = long_fragment(g, down_fragment(g, row, pinned), usize::MAX, pinned) {
                for m in middle_nodes(g, up, down, true) {
                    s.hidden[m] = true;
                }
                s.dotted.insert((up, down));
            }
        }
        s
    }

    /// LINEAR_EXPAND: shows the middle of one dotted edge.
    pub fn expand(&mut self, g: &impl LinearGraph, up: usize, down: usize) -> bool {
        if !self.dotted.remove(&(up, down)) {
            return false;
        }
        for m in middle_nodes(g, up, down, true) {
            self.hidden[m] = false;
        }
        true
    }

    /// Expands the dotted edge that hides `row`, if any.
    pub fn reveal(&mut self, g: &impl LinearGraph, row: usize) -> bool {
        if !self.hidden.get(row).copied().unwrap_or(false) {
            return false;
        }
        let edge = self.dotted.iter().copied().filter(|&(u, d)| u < row && row < d).find(|&(u, d)| middle_nodes(g, u, d, true).contains(&row));
        match edge {
            Some((u, d)) => self.expand(g, u, d),
            None => false,
        }
    }
}

/// The delegate graph with collapsed fragments removed. Node indices are compiled rows.
pub struct CollapsedGraph<G: LinearGraph> {
    pub delegate: G,
    state: Arc<CollapseState>,
    /// Delegate row of each compiled row.
    rows: Vec<usize>,
    /// Compiled row of each delegate row, or -1 when hidden.
    compiled: Vec<i32>,
}

impl<G: LinearGraph> CollapsedGraph<G> {
    pub fn new(delegate: G, state: Arc<CollapseState>) -> Self {
        let n = delegate.nodes_count();
        let mut rows = Vec::with_capacity(n);
        let mut compiled = vec![-1i32; n];
        for (d, c) in compiled.iter_mut().enumerate() {
            if !state.hidden.get(d).copied().unwrap_or(false) {
                *c = rows.len() as i32;
                rows.push(d);
            }
        }
        CollapsedGraph { delegate, state, rows, compiled }
    }

    pub fn delegate_row(&self, row: usize) -> usize {
        self.rows[row]
    }

    pub fn compiled_row(&self, delegate_row: usize) -> Option<usize> {
        let c = *self.compiled.get(delegate_row)?;
        (c >= 0).then_some(c as usize)
    }

    /// Whether the edge between two compiled rows is a collapsed fragment.
    pub fn is_collapsed_edge(&self, up: usize, down: usize) -> bool {
        self.state.dotted.contains(&(self.rows[up], self.rows[down]))
    }

    fn map(&self, e: &Edge) -> Option<Edge> {
        let up = match e.up {
            Some(u) => Some(self.compiled_row(u)?),
            None => None,
        };
        let down = match e.down {
            Some(d) => Some(self.compiled_row(d)?),
            None => None,
        };
        Some(Edge { up, down, target: e.target, ty: e.ty })
    }
}

impl<G: LinearGraph> LinearGraph for CollapsedGraph<G> {
    fn nodes_count(&self) -> usize {
        self.rows.len()
    }

    fn node_type(&self, node: usize) -> NodeType {
        self.delegate.node_type(self.rows[node])
    }

    fn adjacent_edges(&self, node: usize, filter: EdgeFilter) -> Vec<Edge> {
        let d = self.rows[node];
        let mut out: Vec<Edge> = self.delegate.adjacent_edges(d, filter).iter().filter_map(|e| self.map(e)).collect();
        if self.state.dotted.is_empty() {
            return out;
        }
        for &(u, dn) in &self.state.dotted {
            let as_down = u == d && filter.down_normal;
            let as_up = dn == d && filter.up_normal;
            if as_down || as_up {
                if let (Some(cu), Some(cd)) = (self.compiled_row(u), self.compiled_row(dn)) {
                    out.push(Edge { up: Some(cu), down: Some(cd), target: None, ty: EdgeType::Dotted });
                }
            }
        }
        out
    }

    fn node_id(&self, node: usize) -> i32 {
        self.delegate.node_id(self.rows[node])
    }

    fn node_index(&self, id: i32) -> Option<usize> {
        self.compiled_row(self.delegate.node_index(id)?)
    }
}

/// LINEAR_COLLAPSE: collapses the long fragment around a compiled row. Returns false when there is none.
pub fn collapse_at<G: LinearGraph>(
    state: &mut CollapseState,
    graph: &CollapsedGraph<G>,
    row: usize,
    pinned_delegate: &HashSet<usize>,
) -> bool {
    let pinned: HashSet<usize> = pinned_delegate.iter().filter_map(|&d| graph.compiled_row(d)).collect();
    let Some((up, down)) = long_fragment(graph, relative_fragment(graph, row, row, &pinned), usize::MAX, &pinned) else {
        return false;
    };
    let middle = middle_nodes(graph, up, down, true);
    if middle.is_empty() {
        return false;
    }
    for &m in &middle {
        let dm = graph.delegate_row(m);
        state.hidden[dm] = true;
        state.dotted.retain(|&(u, d)| u != dm && d != dm);
    }
    state.dotted.insert((graph.delegate_row(up), graph.delegate_row(down)));
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::linear::{GraphCommit, PermanentLinearGraph};

    fn graph(spec: &[(u32, &[u32])]) -> PermanentLinearGraph {
        let commits: Vec<GraphCommit<u32>> = spec.iter().map(|(id, ps)| GraphCommit { id: *id, parents: ps.to_vec() }).collect();
        PermanentLinearGraph::build(&commits, |_| i32::MIN)
    }

    #[test]
    fn collapses_a_side_branch_and_expands_it() {
        // 0 merges 1 (main) and 2 (side); side: 2 -> 3 -> 4 -> 5; main: 1 -> 5
        let g = graph(&[(0, &[1, 2]), (1, &[5]), (2, &[3]), (3, &[4]), (4, &[5]), (5, &[])]);
        let pinned = HashSet::from([0]);
        let mut s = CollapseState::collapse_all(&g, &pinned);
        assert_eq!(s.dotted.iter().copied().collect::<Vec<_>>(), vec![(0, 5)]);
        assert_eq!(s.hidden, vec![false, true, true, true, true, false]);
        let state = Arc::new(s.clone());
        let c = CollapsedGraph::new(&g, state);
        assert_eq!(c.nodes_count(), 2);
        assert_eq!(c.down_nodes(0), vec![1]);
        assert!(c.is_collapsed_edge(0, 1));
        assert!(s.expand(&g, 0, 5));
        assert!(s.hidden.iter().all(|h| !h));
    }

    #[test]
    fn a_ref_stops_the_fragment() {
        // linear 0 -> 1 -> 2 -> 3 -> 4 with a ref on 2
        let g = graph(&[(0, &[1]), (1, &[2]), (2, &[3]), (3, &[4]), (4, &[])]);
        let s = CollapseState::collapse_all(&g, &HashSet::from([0, 2]));
        assert!(!s.hidden[2]);
        assert_eq!(s.dotted.iter().copied().collect::<Vec<_>>(), vec![(0, 2), (2, 4)]);
    }

    #[test]
    fn collapse_at_then_reveal() {
        let g = graph(&[(0, &[1]), (1, &[2]), (2, &[3]), (3, &[4]), (4, &[])]);
        let pinned = HashSet::from([0]);
        let mut s = CollapseState { hidden: vec![false; 5], dotted: BTreeSet::new() };
        let c = CollapsedGraph::new(&g, Arc::new(s.clone()));
        assert!(collapse_at(&mut s, &c, 2, &pinned));
        assert_eq!(s.dotted.iter().copied().collect::<Vec<_>>(), vec![(0, 4)]);
        assert!(s.reveal(&g, 2));
        assert!(s.is_empty());
    }
}
