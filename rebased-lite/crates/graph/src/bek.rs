// Ported from IntelliJ Community `platform/vcs-log/graph` (Apache-2.0):
// BekSorter, BekBranchCreator, BekBranch, BekBranchMerger, BekEdgeRestrictions,
// SortIndexMap and SortedBaseController.SortedLinearGraph.
//
// IntelliSort: in case of a merge, show the incoming commits first, directly below the merge commit.

use crate::layout::{walk, GraphLayout, NODE_NOT_FOUND};
use crate::linear::{Edge, EdgeFilter, LinearGraph};
use std::collections::HashMap;

const MAX_BLOCK_SIZE: usize = 20;
const MAX_DELTA_TIME: i64 = 60 * 60 * 24 * 3 * 1000;
const SMALL_DELTA_TIME: i64 = 60 * 60 * 4 * 1000;

/// Maps a sorted row to its permanent node and back.
#[derive(Clone, Debug)]
pub struct SortIndexMap {
    map: Vec<u32>,
    reverse: Vec<u32>,
}

impl SortIndexMap {
    pub fn new(list: Vec<u32>) -> SortIndexMap {
        let mut reverse = vec![0u32; list.len()];
        for (i, &v) in list.iter().enumerate() {
            reverse[v as usize] = i as u32;
        }
        SortIndexMap { map: list, reverse }
    }

    pub fn identity(n: usize) -> SortIndexMap {
        SortIndexMap::new((0..n as u32).collect())
    }

    pub fn sorted_index(&self, usual: usize) -> usize {
        self.reverse[usual] as usize
    }

    pub fn usual_index(&self, sorted: usize) -> usize {
        self.map[sorted] as usize
    }
}

#[derive(Default)]
struct EdgeRestrictions {
    up_to_down: HashMap<usize, Vec<usize>>,
    down_to_up: HashMap<usize, Vec<usize>>,
}

impl EdgeRestrictions {
    fn add(&mut self, up: usize, down: usize) {
        let downs = self.up_to_down.entry(up).or_default();
        if !downs.contains(&down) {
            downs.push(down);
        }
        let ups = self.down_to_up.entry(down).or_default();
        if !ups.contains(&up) {
            ups.push(up);
        }
    }

    fn remove(&mut self, down: usize) {
        if let Some(ups) = self.down_to_up.get(&down) {
            for up in ups {
                if let Some(downs) = self.up_to_down.get_mut(up) {
                    if let Some(p) = downs.iter().position(|&d| d == down) {
                        downs.remove(p);
                    }
                    if downs.is_empty() {
                        self.up_to_down.remove(up);
                    }
                }
            }
        }
    }

    fn has(&self, up: usize) -> bool {
        self.up_to_down.contains_key(&up)
    }
}

struct BekBranch {
    nodes: Vec<usize>,
    no_insert_size: usize,
    prepared: Option<(usize, usize)>, // range in `nodes`
}

impl BekBranch {
    fn update_prepared(&mut self, graph: &impl LinearGraph, ts: &dyn Fn(usize) -> i64, r: &EdgeRestrictions) {
        debug_assert!(self.prepared.is_none());
        let current = self.nodes[self.no_insert_size - 1];
        if r.has(current) {
            return;
        }
        let mut prev = self.no_insert_size - 1;
        while prev > 0 {
            let up = self.nodes[prev - 1];
            let down = self.nodes[prev];
            if r.has(up) {
                break;
            }
            let downs = graph.down_nodes(up);
            if downs.len() > 1 && downs.contains(&down) {
                prev -= 1;
                continue;
            }
            if !downs.contains(&down) {
                break;
            }
            let delta = (ts(up) - ts(down)).abs();
            if delta > MAX_DELTA_TIME {
                break;
            }
            if prev + MAX_BLOCK_SIZE < self.no_insert_size && delta > SMALL_DELTA_TIME {
                break;
            }
            prev -= 1;
        }
        self.prepared = Some((prev, self.no_insert_size));
    }

    fn prepared_first_timestamp(&self, ts: &dyn Fn(usize) -> i64) -> i64 {
        match self.prepared {
            Some((s, _)) => ts(self.nodes[s]),
            None => i64::MAX,
        }
    }
}

fn create_branches(graph: &impl LinearGraph, layout: &GraphLayout) -> (Vec<BekBranch>, EdgeRestrictions) {
    let n = graph.nodes_count();
    let mut done = vec![false; n];
    let mut restrictions = EdgeRestrictions::default();
    let mut branches = Vec::new();
    for &head in layout.head_nodes() {
        if done[head] {
            continue;
        }
        done[head] = true;
        let mut nodes = vec![head];
        let start_layout = layout.layout_index(head);
        walk(head, |current| {
            let current_layout = layout.layout_index(current);
            let downs = graph.down_nodes(current);
            for &down in downs.iter().rev() {
                if done[down] {
                    if layout.layout_index(down) < start_layout {
                        restrictions.add(current, down);
                    }
                } else if current_layout <= layout.layout_index(down) {
                    let has_undone_up = graph.up_nodes(down).into_iter().any(|up| {
                        !done[up] && layout.layout_index(up) <= layout.layout_index(down)
                    });
                    if !has_undone_up {
                        done[down] = true;
                        nodes.push(down);
                        return down as i64;
                    }
                }
            }
            NODE_NOT_FOUND
        });
        let size = nodes.len();
        branches.push(BekBranch { nodes, no_insert_size: size, prepared: None });
    }
    (branches, restrictions)
}

/// Computes the IntelliSort row order. `timestamp(node)` is the commit time in milliseconds.
pub fn bek_map(graph: &impl LinearGraph, layout: &GraphLayout, timestamp: impl Fn(usize) -> i64) -> SortIndexMap {
    let ts: &dyn Fn(usize) -> i64 = &timestamp;
    let (mut branches, mut restrictions) = create_branches(graph, layout);
    let mut inverse: Vec<u32> = Vec::with_capacity(graph.nodes_count());
    loop {
        let mut has_undone = false;
        for b in branches.iter_mut() {
            if b.no_insert_size != 0 {
                has_undone = true;
                if b.prepared.is_none() {
                    b.update_prepared(graph, ts, &restrictions);
                }
            }
        }
        if !has_undone {
            break;
        }
        let mut select = 0;
        for i in 0..branches.len() {
            if branches[select].prepared_first_timestamp(ts) > branches[i].prepared_first_timestamp(ts) {
                select = i;
            }
        }
        let (s, e) = branches[select].prepared.expect("a branch must be ready");
        for i in s..e {
            restrictions.remove(branches[select].nodes[i]);
        }
        for i in (s..e).rev() {
            inverse.push(branches[select].nodes[i] as u32);
        }
        let b = &mut branches[select];
        b.no_insert_size -= e - s;
        b.prepared = None;
    }
    inverse.reverse();
    assert_eq!(inverse.len(), graph.nodes_count());
    SortIndexMap::new(inverse)
}

/// The permanent graph seen in sorted row order.
pub struct SortedLinearGraph<G: LinearGraph, M: std::ops::Deref<Target = SortIndexMap>> {
    pub graph: G,
    pub map: M,
}

impl<G: LinearGraph, M: std::ops::Deref<Target = SortIndexMap>> LinearGraph for SortedLinearGraph<G, M> {
    fn nodes_count(&self) -> usize {
        self.graph.nodes_count()
    }

    fn adjacent_edges(&self, node: usize, filter: EdgeFilter) -> Vec<Edge> {
        self.graph
            .adjacent_edges(self.map.usual_index(node), filter)
            .into_iter()
            .map(|e| Edge {
                up: e.up.map(|u| self.map.sorted_index(u)),
                down: e.down.map(|d| self.map.sorted_index(d)),
                target: e.target,
                ty: e.ty,
            })
            .collect()
    }

    fn node_id(&self, node: usize) -> i32 {
        self.map.usual_index(node) as i32
    }

    fn node_index(&self, id: i32) -> Option<usize> {
        if id >= 0 && (id as usize) < self.nodes_count() {
            Some(self.map.sorted_index(id as usize))
        } else {
            None
        }
    }
}
