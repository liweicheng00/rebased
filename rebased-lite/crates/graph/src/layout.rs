// Ported from IntelliJ Community `platform/vcs-log/graph` (Apache-2.0):
// GraphLayoutBuilder, GraphLayoutImpl and Dfs.walk.

use crate::linear::LinearGraph;
use std::cmp::Ordering;

pub const NODE_NOT_FOUND: i64 = -1;
pub const EXIT: i64 = -10;

/// Depth-first walk driven by `next`: return a node to descend, `NODE_NOT_FOUND` to pop, or `EXIT`.
pub fn walk(start: usize, mut next: impl FnMut(usize) -> i64) {
    let mut stack = vec![start];
    while let Some(&top) = stack.last() {
        let n = next(top);
        if n == EXIT {
            return;
        }
        if n == NODE_NOT_FOUND {
            stack.pop();
        } else {
            stack.push(n as usize);
        }
    }
}

/// Layout index of every node: nodes on one first-parent chain share an index. It orders elements left to right.
#[derive(Clone, Debug)]
pub struct GraphLayout {
    layout_index: Vec<i32>,
    head_nodes: Vec<usize>,
    head_layout_index: Vec<i32>,
}

impl GraphLayout {
    pub fn layout_index(&self, node: usize) -> i32 {
        self.layout_index[node]
    }

    pub fn head_nodes(&self) -> &[usize] {
        &self.head_nodes
    }

    /// The head whose fragment contains `node`.
    pub fn one_of_head_node(&self, node: usize) -> usize {
        self.head_node_for_layout_index(self.layout_index(node))
    }

    pub fn head_node_for_layout_index(&self, layout_index: i32) -> usize {
        let order = match self.head_layout_index.binary_search(&layout_index) {
            Ok(i) => i,
            Err(i) => i.saturating_sub(1),
        };
        self.head_nodes[order]
    }
}

pub fn heads(graph: &impl LinearGraph) -> Vec<usize> {
    (0..graph.nodes_count()).filter(|&i| graph.up_nodes(i).is_empty()).collect()
}

/// `branches` are extra rows that start a branch (ref targets); `cmp` orders heads by importance (left first).
pub fn build(
    graph: &impl LinearGraph,
    branches: &[usize],
    mut cmp: impl FnMut(usize, usize) -> Ordering,
) -> GraphLayout {
    let mut seen = std::collections::HashSet::new();
    let mut all: Vec<usize> = branches.iter().copied().chain(heads(graph)).filter(|h| seen.insert(*h)).collect();
    all.sort_by(|&a, &b| cmp(a, b));
    build_sorted(graph, &all)
}

fn build_sorted(graph: &impl LinearGraph, sorted_heads: &[usize]) -> GraphLayout {
    let mut layout_index = vec![0i32; graph.nodes_count()];
    let mut head_nodes = Vec::new();
    let mut current = 1i32;
    for &head in sorted_heads {
        if layout_index[head] != 0 {
            continue;
        }
        head_nodes.push(head);
        walk(head, |node| {
            let first = layout_index[node] == 0;
            if first {
                layout_index[node] = current;
            }
            match graph.down_nodes(node).into_iter().find(|&c| layout_index[c] == 0) {
                Some(c) => c as i64,
                None => {
                    if first {
                        current += 1;
                    }
                    NODE_NOT_FOUND
                }
            }
        });
    }
    let head_layout_index = head_nodes.iter().map(|&h| layout_index[h]).collect();
    GraphLayout { layout_index, head_nodes, head_layout_index }
}
