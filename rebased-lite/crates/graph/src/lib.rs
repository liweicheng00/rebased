//! Commit graph layout for Rebased Lite.
//!
//! The algorithms are a port of the IntelliJ Community `platform/vcs-log/graph` module (Apache-2.0),
//! so the graph looks the same as in Rebased. See `docs/rebased-lite/design-spec.md`, chapter 4.

pub mod bek;
pub mod filter;
pub mod layout;
pub mod linear;
pub mod print;

use bek::{SortIndexMap, SortedLinearGraph};
use layout::GraphLayout;
use linear::{EdgeType, GraphCommit, LinearGraph, PermanentLinearGraph};
use print::{EdgeLimits, Element, PrintElement, PrintElementGenerator};
use std::cmp::Ordering;
use std::hash::Hash;
use std::sync::Arc;

pub type VisibleGraph = SortedLinearGraph<Arc<PermanentLinearGraph>, Arc<SortIndexMap>>;
pub type LayoutIndexFn = Box<dyn Fn(usize) -> i32 + Send + Sync>;
pub type Printer = PrintElementGenerator<VisibleGraph, LayoutIndexFn>;

/// Ref kinds in the order of `GitBranchLayoutComparator`: the first kind is laid out leftmost.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum RefKind {
    OriginMaster,
    RemoteBranch,
    Master,
    LocalBranch,
    Tag,
    CurrentBranch,
    Head,
    Other,
}

#[derive(Clone, Debug)]
pub struct RefInfo {
    pub name: String,
    pub kind: RefKind,
}

pub struct GraphOptions {
    pub intelli_sort: bool,
    pub show_long_edges: bool,
}

impl Default for GraphOptions {
    fn default() -> Self {
        GraphOptions { intelli_sort: true, show_long_edges: false }
    }
}

/// A laid-out graph. Rows are visible rows (after IntelliSort); nodes are permanent node ids (input order).
pub struct Graph {
    permanent: Arc<PermanentLinearGraph>,
    layout: Arc<GraphLayout>,
    sort: Arc<SortIndexMap>,
    /// Color key of the first ref of each head node (name hash), if the head has a ref.
    head_ref_color: std::collections::HashMap<usize, i32>,
    limits: EdgeLimits,
    /// Edges (child node, parent node) drawn dashed: they skip hidden commits in a filtered view.
    dotted: std::collections::HashSet<(usize, usize)>,
}

/// Same as Java `String.hashCode`, so branch colors match Rebased.
pub fn java_string_hash(s: &str) -> i32 {
    s.encode_utf16().fold(0i32, |h, c| h.wrapping_mul(31).wrapping_add(c as i32))
}

impl Graph {
    /// `commits` must be in `git log --date-order` order. `refs[i]` are the refs that point to `commits[i]`.
    /// `timestamps` are commit times in seconds.
    pub fn build<Id: Eq + Hash + Clone>(
        commits: &[GraphCommit<Id>],
        timestamps: &[i64],
        refs: &[Vec<RefInfo>],
        options: &GraphOptions,
    ) -> Graph {
        let mut next_missing = -2i32;
        let permanent = PermanentLinearGraph::build(commits, |_| {
            let id = next_missing;
            next_missing -= 1;
            id
        });

        // The first ref of a head by label order decides its place; see HeadCommitsComparator.
        let best_ref = |node: usize| -> Option<&RefInfo> {
            refs.get(node)?.iter().min_by(|a, b| a.kind.cmp(&b.kind).then_with(|| a.name.cmp(&b.name)))
        };
        let branches: Vec<usize> = (0..commits.len()).filter(|&i| refs.get(i).is_some_and(|r| !r.is_empty())).collect();
        let layout = layout::build(&permanent, &branches, |a, b| {
            if a == b {
                return Ordering::Equal;
            }
            match (best_ref(a), best_ref(b)) {
                (None, None) => a.cmp(&b),
                (None, Some(_)) => Ordering::Greater,
                (Some(_), None) => Ordering::Less,
                (Some(r1), Some(r2)) => r1.kind.cmp(&r2.kind).then_with(|| r1.name.cmp(&r2.name)),
            }
        });

        let sort = if options.intelli_sort {
            bek::bek_map(&permanent, &layout, |n| timestamps.get(n).copied().unwrap_or(0) * 1000)
        } else {
            SortIndexMap::identity(commits.len())
        };

        let head_ref_color = layout
            .head_nodes()
            .iter()
            .filter_map(|&h| {
                let label = refs.get(h)?.iter().min_by(|a, b| label_order(a).cmp(&label_order(b)).then_with(|| a.name.cmp(&b.name)))?;
                Some((h, java_string_hash(&label.name)))
            })
            .collect();

        Graph {
            permanent: Arc::new(permanent),
            layout: Arc::new(layout),
            sort: Arc::new(sort),
            head_ref_color,
            limits: EdgeLimits::new(options.show_long_edges),
            dotted: Default::default(),
        }
    }

    /// Marks edges (child node, parent node) as dotted.
    pub fn set_dotted(&mut self, edges: impl IntoIterator<Item = (usize, usize)>) {
        self.dotted = edges.into_iter().collect();
    }

    pub fn permanent(&self) -> &PermanentLinearGraph {
        &self.permanent
    }

    /// Whether the edge between two visible rows is dashed.
    pub fn is_edge_dashed(&self, edge: &linear::Edge) -> bool {
        if Self::is_dashed(edge.ty) {
            return true;
        }
        match edge.as_normal() {
            Some((up, down)) if !self.dotted.is_empty() => self.dotted.contains(&(self.node_at_row(up), self.node_at_row(down))),
            _ => false,
        }
    }

    pub fn row_count(&self) -> usize {
        self.permanent.nodes_count()
    }

    /// Permanent node (index into the input commits) shown at `row`.
    pub fn node_at_row(&self, row: usize) -> usize {
        self.sort.usual_index(row)
    }

    pub fn row_of_node(&self, node: usize) -> usize {
        self.sort.sorted_index(node)
    }

    pub fn visible_graph(&self) -> VisibleGraph {
        SortedLinearGraph { graph: self.permanent.clone(), map: self.sort.clone() }
    }

    /// A row printer that owns its data, so it can live next to the graph in app state.
    pub fn printer(&self) -> Printer {
        let (layout, sort) = (self.layout.clone(), self.sort.clone());
        let layout_index: LayoutIndexFn = Box::new(move |row| layout.layout_index(sort.usual_index(row)));
        PrintElementGenerator::new(self.visible_graph(), layout_index, self.limits)
    }

    /// Color key of a permanent node; see GraphColorGetterByHead and GraphColorManagerImpl.
    pub fn node_color(&self, node: usize) -> i32 {
        let li = self.layout.layout_index(node);
        let head = self.layout.one_of_head_node(node);
        if self.layout.layout_index(head) == li {
            *self.head_ref_color.get(&head).unwrap_or(&0)
        } else {
            li
        }
    }

    /// Color key of a print element in visible coordinates; see PrintElementPresentationManagerImpl.
    pub fn element_color(&self, element: &PrintElement) -> i32 {
        match element.element() {
            Element::Node(row) => self.node_color(self.node_at_row(row)),
            Element::Edge(e) => match e.as_normal() {
                None => self.node_color(self.node_at_row(e.not_null_node())),
                Some((up, down)) => {
                    let (un, dn) = (self.node_at_row(up), self.node_at_row(down));
                    if self.layout.layout_index(un) >= self.layout.layout_index(dn) {
                        self.node_color(un)
                    } else {
                        self.node_color(dn)
                    }
                }
            },
        }
    }

    pub fn is_dashed(ty: EdgeType) -> bool {
        print::line_style(ty) == print::LineStyle::Dashed
    }

    pub fn layout(&self) -> &GraphLayout {
        &self.layout
    }
}

/// Label order of `GitLabelComparator`, used to pick the ref that names a head.
fn label_order(r: &RefInfo) -> u8 {
    match r.kind {
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
