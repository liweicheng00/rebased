//! Filtered view of a graph. Hidden commits are removed; a visible commit gets a dotted edge to the nearest
//! visible commits below the hidden ones, like the IntelliJ filtered log.

use crate::linear::PermanentLinearGraph;

/// Nearest visible commits kept for a chain of hidden commits. One keeps filtered graphs narrow (6-8 lanes on git/git).
const MAX_REACH: usize = 1;

pub struct FilteredCommits {
    /// Visible nodes of the full graph, in the original order.
    pub nodes: Vec<usize>,
    /// Parents of each visible node, as nodes of the full graph, with `true` for a dotted edge.
    pub parents: Vec<Vec<(usize, bool)>>,
}

/// `visible[n]` tells whether node `n` of `graph` matches the filter.
pub fn filter(graph: &PermanentLinearGraph, visible: &[bool]) -> FilteredCommits {
    let n = visible.len();
    // Nearest visible nodes below each hidden node. Parents always have a larger index, so go bottom up.
    let mut reach: Vec<Vec<usize>> = vec![Vec::new(); n];
    let mut parents_of_visible: Vec<Option<Vec<(usize, bool)>>> = vec![None; n];
    for node in (0..n).rev() {
        let mut targets: Vec<(usize, bool)> = Vec::new();
        graph.for_each_parent(node, |p| {
            if p < 0 {
                return;
            }
            let p = p as usize;
            if visible[p] {
                targets.push((p, false));
            } else {
                for &r in &reach[p] {
                    targets.push((r, true));
                }
            }
        });
        let mut dedup: Vec<(usize, bool)> = Vec::with_capacity(targets.len());
        for (t, dotted) in targets {
            match dedup.iter_mut().find(|(x, _)| *x == t) {
                Some(e) => e.1 &= dotted,
                None => dedup.push((t, dotted)),
            }
        }
        if visible[node] {
            parents_of_visible[node] = Some(dedup);
        } else {
            dedup.truncate(MAX_REACH);
            reach[node] = dedup.into_iter().map(|(t, _)| t).collect();
        }
    }
    let nodes: Vec<usize> = (0..n).filter(|&i| visible[i]).collect();
    let parents = nodes.iter().map(|&i| parents_of_visible[i].take().unwrap_or_default()).collect();
    FilteredCommits { nodes, parents }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::linear::GraphCommit;

    fn graph(spec: &[(u32, &[u32])]) -> PermanentLinearGraph {
        let commits: Vec<GraphCommit<u32>> = spec.iter().map(|(id, ps)| GraphCommit { id: *id, parents: ps.to_vec() }).collect();
        PermanentLinearGraph::build(&commits, |_| i32::MIN)
    }

    #[test]
    fn hidden_chain_becomes_dotted_edge() {
        // 0 -> 1 -> 2 -> 3, hide 1 and 2
        let g = graph(&[(0, &[1]), (1, &[2]), (2, &[3]), (3, &[])]);
        let f = filter(&g, &[true, false, false, true]);
        assert_eq!(f.nodes, vec![0, 3]);
        assert_eq!(f.parents, vec![vec![(3, true)], vec![]]);
    }

    #[test]
    fn direct_edge_wins_over_dotted() {
        // 0 merges 1 and 2; 1 -> 3; 2 -> 3; hide 1
        let g = graph(&[(0, &[1, 2]), (1, &[3]), (2, &[3]), (3, &[])]);
        let f = filter(&g, &[true, false, true, true]);
        assert_eq!(f.nodes, vec![0, 2, 3]);
        assert_eq!(f.parents[0], vec![(3, true), (2, false)]);
        assert_eq!(f.parents[1], vec![(3, false)]);
    }
}
