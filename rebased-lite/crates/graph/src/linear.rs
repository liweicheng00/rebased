// Ported from IntelliJ Community `platform/vcs-log/graph` (Apache-2.0):
// GraphEdge, GraphEdgeType, EdgeFilter, LinearGraph, PermanentLinearGraphBuilder,
// PermanentLinearGraphImpl and DuplicateParentFixer.

use std::collections::HashMap;
use std::hash::Hash;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum EdgeType {
    Usual,
    Dotted,
    NotLoadCommit,
    DottedArrowUp,
    DottedArrowDown,
}

impl EdgeType {
    pub fn is_normal(self) -> bool {
        matches!(self, EdgeType::Usual | EdgeType::Dotted)
    }
}

/// An edge between two rows. A normal edge has both ends; a special edge has one end and a target id.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Edge {
    pub up: Option<usize>,
    pub down: Option<usize>,
    pub target: Option<i32>,
    pub ty: EdgeType,
}

impl Edge {
    pub fn normal(a: usize, b: usize, ty: EdgeType) -> Edge {
        debug_assert!(ty.is_normal());
        Edge { up: Some(a.min(b)), down: Some(a.max(b)), target: None, ty }
    }

    pub fn with_target(node: usize, target: Option<i32>, ty: EdgeType) -> Edge {
        match ty {
            EdgeType::DottedArrowUp => Edge { up: None, down: Some(node), target, ty },
            EdgeType::NotLoadCommit | EdgeType::DottedArrowDown => Edge { up: Some(node), down: None, target, ty },
            _ => panic!("unexpected edge type {ty:?}"),
        }
    }

    /// `(up, down)` for a normal edge.
    pub fn as_normal(&self) -> Option<(usize, usize)> {
        if self.ty.is_normal() {
            Some((self.up.unwrap(), self.down.unwrap()))
        } else {
            None
        }
    }

    pub fn not_null_node(&self) -> usize {
        self.up.or(self.down).unwrap()
    }

    pub fn is_up_of(&self, node: usize) -> bool {
        self.down == Some(node)
    }

    pub fn is_down_of(&self, node: usize) -> bool {
        self.up == Some(node)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct EdgeFilter {
    pub special: bool,
    pub up_normal: bool,
    pub down_normal: bool,
}

impl EdgeFilter {
    pub const ALL: EdgeFilter = EdgeFilter { special: true, up_normal: true, down_normal: true };
    pub const NORMAL_UP: EdgeFilter = EdgeFilter { special: false, up_normal: true, down_normal: false };
    pub const NORMAL_DOWN: EdgeFilter = EdgeFilter { special: false, up_normal: false, down_normal: true };
    pub const SPECIAL: EdgeFilter = EdgeFilter { special: true, up_normal: false, down_normal: false };
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NodeType {
    Usual,
    Unmatched,
    NotLoadCommit,
}

pub trait LinearGraph {
    fn nodes_count(&self) -> usize;
    fn node_type(&self, _node: usize) -> NodeType {
        NodeType::Usual
    }
    fn adjacent_edges(&self, node: usize, filter: EdgeFilter) -> Vec<Edge>;
    /// Stable id of the node at `node`. For the permanent graph the id equals the index.
    fn node_id(&self, node: usize) -> i32;
    fn node_index(&self, id: i32) -> Option<usize>;

    fn up_nodes(&self, node: usize) -> Vec<usize> {
        self.adjacent_edges(node, EdgeFilter::NORMAL_UP).into_iter().filter_map(|e| e.up).collect()
    }

    fn down_nodes(&self, node: usize) -> Vec<usize> {
        self.adjacent_edges(node, EdgeFilter::NORMAL_DOWN).into_iter().filter_map(|e| e.down).collect()
    }
}

impl<T: LinearGraph + ?Sized> LinearGraph for &T {
    fn nodes_count(&self) -> usize {
        (**self).nodes_count()
    }
    fn node_type(&self, node: usize) -> NodeType {
        (**self).node_type(node)
    }
    fn adjacent_edges(&self, node: usize, filter: EdgeFilter) -> Vec<Edge> {
        (**self).adjacent_edges(node, filter)
    }
    fn node_id(&self, node: usize) -> i32 {
        (**self).node_id(node)
    }
    fn node_index(&self, id: i32) -> Option<usize> {
        (**self).node_index(id)
    }
}

impl<T: LinearGraph + ?Sized> LinearGraph for std::sync::Arc<T> {
    fn nodes_count(&self) -> usize {
        (**self).nodes_count()
    }
    fn node_type(&self, node: usize) -> NodeType {
        (**self).node_type(node)
    }
    fn adjacent_edges(&self, node: usize, filter: EdgeFilter) -> Vec<Edge> {
        (**self).adjacent_edges(node, filter)
    }
    fn node_id(&self, node: usize) -> i32 {
        (**self).node_id(node)
    }
    fn node_index(&self, id: i32) -> Option<usize> {
        (**self).node_index(id)
    }
}

/// A commit in topological order (children before parents).
#[derive(Clone, Debug)]
pub struct GraphCommit<Id> {
    pub id: Id,
    pub parents: Vec<Id>,
}

/// Compact graph: a node whose only parent is the next row is "simple" and stores no edges.
#[derive(Clone, Debug)]
pub struct PermanentLinearGraph {
    simple: Vec<bool>,
    node_to_edge: Vec<u32>,
    long_edges: Vec<i32>,
}

impl LinearGraph for PermanentLinearGraph {
    fn nodes_count(&self) -> usize {
        self.simple.len()
    }

    fn adjacent_edges(&self, node: usize, filter: EdgeFilter) -> Vec<Edge> {
        let mut result = Vec::new();
        if node != 0 && self.simple[node - 1] && filter.up_normal {
            result.push(Edge { up: Some(node - 1), down: Some(node), target: None, ty: EdgeType::Usual });
        }
        for i in self.node_to_edge[node] as usize..self.node_to_edge[node + 1] as usize {
            let adjacent = self.long_edges[i];
            if adjacent < 0 {
                if filter.special {
                    result.push(Edge::with_target(node, Some(adjacent), EdgeType::NotLoadCommit));
                }
                continue;
            }
            let adjacent = adjacent as usize;
            if node > adjacent && filter.up_normal {
                result.push(Edge { up: Some(adjacent), down: Some(node), target: None, ty: EdgeType::Usual });
            }
            if node < adjacent && filter.down_normal {
                result.push(Edge { up: Some(node), down: Some(adjacent), target: None, ty: EdgeType::Usual });
            }
        }
        if self.simple[node] && filter.down_normal {
            result.push(Edge { up: Some(node), down: Some(node + 1), target: None, ty: EdgeType::Usual });
        }
        result
    }

    fn node_id(&self, node: usize) -> i32 {
        node as i32
    }

    fn node_index(&self, id: i32) -> Option<usize> {
        if id >= 0 && (id as usize) < self.nodes_count() {
            Some(id as usize)
        } else {
            None
        }
    }
}

fn fix_duplicate_parents<Id: Eq + Hash + Clone>(parents: &[Id]) -> Vec<Id> {
    let mut seen = std::collections::HashSet::with_capacity(parents.len());
    parents.iter().filter(|p| seen.insert((*p).clone())).cloned().collect()
}

impl PermanentLinearGraph {
    /// Builds the graph. `not_loaded_id` gives an id (must be < -1) for a parent that is not in `commits`;
    /// it is called in order of the first child that references the parent.
    pub fn build<Id: Eq + Hash + Clone>(
        commits: &[GraphCommit<Id>],
        mut not_loaded_id: impl FnMut(&Id) -> i32,
    ) -> PermanentLinearGraph {
        let n = commits.len();
        let parents: Vec<Vec<Id>> = commits.iter().map(|c| fix_duplicate_parents(&c.parents)).collect();

        let mut simple = vec![false; n];
        let mut long_edges_count = 0usize;
        for i in 0..n {
            let next = if i + 1 < n { Some(&commits[i + 1].id) } else { None };
            if parents[i].len() == 1 && Some(&parents[i][0]) == next {
                simple[i] = true;
            } else {
                long_edges_count += parents[i].len();
            }
        }

        let mut node_to_edge = vec![0u32; n + 1];
        let mut long_edges = vec![0i32; 2 * long_edges_count];
        // parent id -> child rows waiting for it
        let mut pending: HashMap<Id, Vec<usize>> = HashMap::new();

        for node in 0..n {
            let mut edge_index = node_to_edge[node] as usize;
            if let Some(up_nodes) = pending.remove(&commits[node].id) {
                for up in up_nodes {
                    // point the child's pending slot at this row
                    let end = node_to_edge[up + 1] as usize;
                    let ps = &parents[up];
                    let i = ps.iter().position(|p| *p == commits[node].id).expect("pending edge");
                    let slot = end - (ps.len() - i);
                    assert_eq!(long_edges[slot], -1, "edge set twice");
                    long_edges[slot] = node as i32;
                    long_edges[edge_index] = up as i32;
                    edge_index += 1;
                }
            }
            if !simple[node] {
                for p in &parents[node] {
                    pending.entry(p.clone()).or_default().push(node);
                    long_edges[edge_index] = -1;
                    edge_index += 1;
                }
            }
            node_to_edge[node + 1] = edge_index as u32;
        }

        // Parents that are not loaded, in order of their first child.
        let mut missing: Vec<(Id, Vec<usize>)> = pending.into_iter().collect();
        missing.sort_by_key(|(_, ups)| *ups.iter().min().unwrap());
        for (id, ups) in missing {
            let target = not_loaded_id(&id);
            for up in ups {
                let range = node_to_edge[up] as usize..node_to_edge[up + 1] as usize;
                let slot = range.clone().find(|&e| long_edges[e] == -1).expect("pending not-loaded edge");
                long_edges[slot] = target;
            }
        }

        long_edges.truncate(node_to_edge[n] as usize);
        PermanentLinearGraph { simple, node_to_edge, long_edges }
    }

    /// Parent rows of `node` in parent order. A negative value is a not-loaded parent id.
    pub fn for_each_parent(&self, node: usize, mut f: impl FnMut(i32)) {
        for i in self.node_to_edge[node] as usize..self.node_to_edge[node + 1] as usize {
            let adjacent = self.long_edges[i];
            if adjacent < 0 || (node as i32) < adjacent {
                f(adjacent);
            }
        }
        if self.simple[node] {
            f(node as i32 + 1);
        }
    }
}
