// Ported from IntelliJ Community `platform/vcs-log/graph` (Apache-2.0):
// EdgesInRowGenerator, GraphElementComparatorByLayoutIndex, PrintElementGeneratorImpl
// and the print element classes.

use crate::linear::{Edge, EdgeFilter, EdgeType, LinearGraph};
use std::cell::RefCell;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

pub const LONG_EDGE_SIZE: usize = 30;
const VERY_LONG_EDGE_SIZE: usize = 1000;
const LONG_EDGE_PART_SIZE: usize = 1;
const VERY_LONG_EDGE_PART_SIZE: usize = 250;
const BLOCK_SIZE: usize = 40;
const WALK_SIZE: usize = 1000;
const ROW_CACHE_SIZE: usize = 100;
const EDGE_CACHE_SIZE: usize = 10;
const SAMPLE_SIZE: usize = 20000;
const K: f64 = 0.1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Element {
    Node(usize),
    Edge(Edge),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    Up,
    Down,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LineStyle {
    Solid,
    Dashed,
}

pub fn line_style(ty: EdgeType) -> LineStyle {
    match ty {
        EdgeType::Usual | EdgeType::NotLoadCommit => LineStyle::Solid,
        _ => LineStyle::Dashed,
    }
}

/// What to draw in one row. An edge is drawn as a half segment from this row's center to the row boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PrintElement {
    Node { row: usize, pos: usize, node: usize },
    /// `terminal` marks the short arrow stub at a cut long edge; then `other_pos == pos`.
    Edge { row: usize, pos: usize, other_pos: usize, dir: Direction, arrow: bool, terminal: bool, edge: Edge },
}

impl PrintElement {
    pub fn element(&self) -> Element {
        match *self {
            PrintElement::Node { node, .. } => Element::Node(node),
            PrintElement::Edge { edge, .. } => Element::Edge(edge),
        }
    }

    pub fn pos(&self) -> usize {
        match *self {
            PrintElement::Node { pos, .. } | PrintElement::Edge { pos, .. } => pos,
        }
    }
}

/// Orders elements in one row by layout index; the position of an element in the sorted row is its column.
pub struct ElementComparator<F: Fn(usize) -> i32> {
    pub layout_index: F,
}

impl<F: Fn(usize) -> i32> ElementComparator<F> {
    pub fn compare(&self, a: &Element, b: &Element) -> Ordering {
        let r = match (a, b) {
            (Element::Edge(e1), Element::Edge(e2)) => {
                let (n1, n2) = (e1.as_normal(), e2.as_normal());
                match (n1, n2) {
                    (None, _) => -self.compare2(e2, e1.not_null_node()),
                    (_, None) => self.compare2(e1, e2.not_null_node()),
                    (Some((u1, d1)), Some((u2, d2))) => {
                        if u1 == u2 {
                            if d1 < d2 {
                                -self.compare2(e2, d1)
                            } else {
                                self.compare2(e1, d2)
                            }
                        } else if u1 < u2 {
                            self.compare2(e1, u2)
                        } else {
                            -self.compare2(e2, u1)
                        }
                    }
                }
            }
            (Element::Edge(e), Element::Node(n)) => self.compare2(e, *n),
            (Element::Node(n), Element::Edge(e)) => -self.compare2(e, *n),
            (Element::Node(_), Element::Node(_)) => 0,
        };
        r.cmp(&0)
    }

    fn compare2(&self, edge: &Edge, node: usize) -> i64 {
        let li = |n: usize| (self.layout_index)(n) as i64;
        match edge.as_normal() {
            None => li(edge.not_null_node()) - li(node),
            Some((up, down)) => {
                let edge_li = li(up).max(li(down));
                let node_li = li(node);
                if edge_li != node_li {
                    edge_li - node_li
                } else {
                    up as i64 - node as i64
                }
            }
        }
    }
}

/// Incrementally computes the normal edges that pass through a row.
struct EdgesInRow {
    cache_up: HashMap<usize, (HashSet<Edge>, usize)>,
    cache_down: HashMap<usize, (HashSet<Edge>, usize)>,
}

impl EdgesInRow {
    fn new() -> Self {
        EdgesInRow { cache_up: HashMap::new(), cache_down: HashMap::new() }
    }

    fn get(&mut self, g: &impl LinearGraph, row: usize) -> HashSet<Edge> {
        let mut up = self.neighbor_up(g, row);
        while up.1 < row {
            up = down_step(g, up);
        }
        let mut down = self.neighbor_down(g, row);
        while down.1 > row {
            down = up_step(g, down);
        }
        let mut result = up.0;
        result.extend(down.0);
        result
    }

    fn neighbor_up(&mut self, g: &impl LinearGraph, row: usize) -> (HashSet<Edge>, usize) {
        let key = (row / BLOCK_SIZE) * BLOCK_SIZE;
        if let Some(v) = self.cache_up.get(&key) {
            return v.clone();
        }
        let start = key.saturating_sub(WALK_SIZE);
        let mut edges = (HashSet::new(), start);
        for _ in start..key {
            edges = down_step(g, edges);
        }
        if self.cache_up.len() >= EDGE_CACHE_SIZE * 2 {
            self.cache_up.clear();
        }
        self.cache_up.insert(key, edges.clone());
        edges
    }

    fn neighbor_down(&mut self, g: &impl LinearGraph, row: usize) -> (HashSet<Edge>, usize) {
        let key = (row / BLOCK_SIZE) * BLOCK_SIZE + BLOCK_SIZE;
        if key >= g.nodes_count() {
            return (HashSet::new(), g.nodes_count() - 1);
        }
        if let Some(v) = self.cache_down.get(&key) {
            return v.clone();
        }
        let end = (key + WALK_SIZE).min(g.nodes_count() - 1);
        let mut edges = (HashSet::new(), end);
        for _ in (key + 1..=end).rev() {
            edges = up_step(g, edges);
        }
        if self.cache_down.len() >= EDGE_CACHE_SIZE * 2 {
            self.cache_down.clear();
        }
        self.cache_down.insert(key, edges.clone());
        edges
    }
}

fn down_step(g: &impl LinearGraph, (mut edges, row): (HashSet<Edge>, usize)) -> (HashSet<Edge>, usize) {
    edges.extend(g.adjacent_edges(row, EdgeFilter::NORMAL_DOWN));
    if row + 1 < g.nodes_count() {
        for e in g.adjacent_edges(row + 1, EdgeFilter::NORMAL_UP) {
            edges.remove(&e);
        }
    }
    (edges, row + 1)
}

fn up_step(g: &impl LinearGraph, (mut edges, row): (HashSet<Edge>, usize)) -> (HashSet<Edge>, usize) {
    edges.extend(g.adjacent_edges(row, EdgeFilter::NORMAL_UP));
    if row > 0 {
        for e in g.adjacent_edges(row - 1, EdgeFilter::NORMAL_DOWN) {
            edges.remove(&e);
        }
    }
    (edges, row.wrapping_sub(1))
}

/// Normal edges that pass through `row`, for tests and diagnostics.
pub fn edges_in_row(g: &impl LinearGraph, row: usize) -> HashSet<Edge> {
    EdgesInRow::new().get(g, row)
}

#[derive(Clone, Copy, Debug)]
pub struct EdgeLimits {
    pub long_edge_size: usize,
    pub visible_part_size: usize,
    pub edge_with_arrow_size: usize,
}

impl EdgeLimits {
    pub fn new(show_long_edges: bool) -> EdgeLimits {
        if show_long_edges {
            EdgeLimits {
                long_edge_size: VERY_LONG_EDGE_SIZE,
                visible_part_size: VERY_LONG_EDGE_PART_SIZE,
                edge_with_arrow_size: LONG_EDGE_SIZE,
            }
        } else {
            EdgeLimits { long_edge_size: LONG_EDGE_SIZE, visible_part_size: LONG_EDGE_PART_SIZE, edge_with_arrow_size: usize::MAX }
        }
    }
}

pub struct PrintElementGenerator<G: LinearGraph, F: Fn(usize) -> i32> {
    graph: G,
    cmp: ElementComparator<F>,
    limits: EdgeLimits,
    edges: RefCell<EdgesInRow>,
    rows: RefCell<HashMap<usize, Vec<Element>>>,
}

impl<G: LinearGraph, F: Fn(usize) -> i32> PrintElementGenerator<G, F> {
    pub fn new(graph: G, layout_index: F, limits: EdgeLimits) -> Self {
        PrintElementGenerator {
            graph,
            cmp: ElementComparator { layout_index },
            limits,
            edges: RefCell::new(EdgesInRow::new()),
            rows: RefCell::new(HashMap::new()),
        }
    }

    pub fn print_elements(&self, row: usize) -> Vec<PrintElement> {
        let mut result = Vec::new();
        let mut nodes = Vec::new();
        let visible = self.sorted_visible_elements(row);
        let up_pos = self.end_positions(row as i64 - 1, true);
        let down_pos = self.end_positions(row as i64 + 1, false);
        let push_edge = |result: &mut Vec<PrintElement>, pos: usize, edge: Edge| {
            let arrow = self.arrow_type(&edge, row);
            match down_pos(&edge) {
                Some(other) => result.push(PrintElement::Edge {
                    row, pos, other_pos: other, dir: Direction::Down, arrow: arrow == Some(Direction::Down), terminal: false, edge,
                }),
                None if arrow == Some(Direction::Down) => result.push(PrintElement::Edge {
                    row, pos, other_pos: pos, dir: Direction::Down, arrow: true, terminal: true, edge,
                }),
                None => {}
            }
            match up_pos(&edge) {
                Some(other) => result.push(PrintElement::Edge {
                    row, pos, other_pos: other, dir: Direction::Up, arrow: arrow == Some(Direction::Up), terminal: false, edge,
                }),
                None if arrow == Some(Direction::Up) => result.push(PrintElement::Edge {
                    row, pos, other_pos: pos, dir: Direction::Up, arrow: true, terminal: true, edge,
                }),
                None => {}
            }
        };
        for (pos, el) in visible.iter().enumerate() {
            match *el {
                Element::Node(n) => {
                    nodes.push(PrintElement::Node { row, pos, node: n });
                    for edge in self.graph.adjacent_edges(n, EdgeFilter::ALL) {
                        let arrow = self.arrow_type(&edge, row);
                        if let Some(other) = down_pos(&edge) {
                            result.push(PrintElement::Edge {
                                row, pos, other_pos: other, dir: Direction::Down, arrow: arrow == Some(Direction::Down), terminal: false, edge,
                            });
                        }
                        if let Some(other) = up_pos(&edge) {
                            result.push(PrintElement::Edge {
                                row, pos, other_pos: other, dir: Direction::Up, arrow: arrow == Some(Direction::Up), terminal: false, edge,
                            });
                        }
                    }
                }
                Element::Edge(edge) => push_edge(&mut result, pos, edge),
            }
        }
        result.extend(nodes);
        result
    }

    /// Column of each element in the neighbour row, keyed by element; an edge that ends there maps to its end node.
    fn end_positions(&self, row: i64, up: bool) -> impl Fn(&Edge) -> Option<usize> {
        let mut map: HashMap<Element, usize> = HashMap::new();
        if row >= 0 && (row as usize) < self.graph.nodes_count() {
            for (pos, el) in self.sorted_visible_elements(row as usize).into_iter().enumerate() {
                map.insert(el, pos);
            }
        }
        move |edge: &Edge| {
            if map.is_empty() {
                return None;
            }
            map.get(&Element::Edge(*edge)).copied().or_else(|| {
                let n = if up { edge.up } else { edge.down };
                n.and_then(|n| map.get(&Element::Node(n)).copied())
            })
        }
    }

    fn arrow_type(&self, edge: &Edge, row: usize) -> Option<Direction> {
        if let Some((up, down)) = edge.as_normal() {
            return self.normal_arrow_type(up, down, row);
        }
        match edge.ty {
            EdgeType::DottedArrowDown | EdgeType::NotLoadCommit => {
                if row > 0 && edge.up == Some(row - 1) {
                    return Some(Direction::Down);
                }
            }
            EdgeType::DottedArrowUp => {
                if edge.down == Some(row + 1) {
                    return Some(Direction::Up);
                }
            }
            _ => {}
        }
        None
    }

    fn normal_arrow_type(&self, up: usize, down: usize, row: usize) -> Option<Direction> {
        let size = down - up;
        let up_offset = row as i64 - up as i64;
        let down_offset = down as i64 - row as i64;
        let l = &self.limits;
        if size >= l.long_edge_size {
            if up_offset == l.visible_part_size as i64 {
                return Some(Direction::Down);
            }
            if down_offset == l.visible_part_size as i64 {
                return Some(Direction::Up);
            }
        }
        if size >= l.edge_with_arrow_size {
            if up_offset == 1 {
                return Some(Direction::Down);
            }
            if down_offset == 1 {
                return Some(Direction::Up);
            }
        }
        None
    }

    fn is_edge_visible(&self, edge: &Edge, row: usize) -> bool {
        match edge.as_normal() {
            None => false,
            Some((up, down)) => {
                down - up < self.limits.long_edge_size || (row - up).min(down - row) <= self.limits.visible_part_size
            }
        }
    }

    pub fn sorted_visible_elements(&self, row: usize) -> Vec<Element> {
        if let Some(v) = self.rows.borrow().get(&row) {
            return v.clone();
        }
        let mut result = vec![Element::Node(row)];
        let passing = self.edges.borrow_mut().get(&self.graph, row);
        result.extend(passing.into_iter().filter(|e| self.is_edge_visible(e, row)).map(Element::Edge));
        if row > 0 {
            result.extend(
                self.graph.adjacent_edges(row - 1, EdgeFilter::SPECIAL).into_iter().filter(|e| e.is_down_of(row - 1)).map(Element::Edge),
            );
        }
        if row + 1 < self.graph.nodes_count() {
            result.extend(
                self.graph.adjacent_edges(row + 1, EdgeFilter::SPECIAL).into_iter().filter(|e| e.is_up_of(row + 1)).map(Element::Edge),
            );
        }
        result.sort_by(|a, b| self.cmp.compare(a, b));
        let mut rows = self.rows.borrow_mut();
        if rows.len() >= ROW_CACHE_SIZE * 2 {
            rows.clear();
        }
        rows.insert(row, result.clone());
        result
    }

    /// Weighted mean plus one deviation of the row width over the first rows.
    pub fn recommended_width(&self) -> usize {
        let count = self.graph.nodes_count();
        if count == 0 {
            return 0;
        }
        if count == 1 {
            return 1;
        }
        let n = SAMPLE_SIZE.min(count);
        let (mut sum, mut sum_sq) = (0.0f64, 0.0f64);
        let mut edges_count = 0usize;
        let mut current: HashSet<(usize, usize)> = HashSet::new();
        for i in 0..n {
            let (mut up_arrows, mut down_arrows) = (0usize, 0usize);
            for e in self.graph.adjacent_edges(i, EdgeFilter::ALL) {
                match e.as_normal() {
                    Some(ne) => {
                        if e.is_up_of(i) {
                            current.remove(&ne);
                        } else {
                            current.insert(ne);
                        }
                    }
                    None => {
                        if e.ty == EdgeType::DottedArrowUp {
                            up_arrows += 1;
                        } else {
                            down_arrows += 1;
                        }
                    }
                }
            }
            let mut new_edges = 0usize;
            for &(up, down) in &current {
                if down - up < self.limits.long_edge_size || (i - up).min(down - i) <= self.limits.visible_part_size {
                    new_edges += 1;
                } else {
                    match self.normal_arrow_type(up, down, i) {
                        Some(Direction::Down) => down_arrows += 1,
                        Some(Direction::Up) => up_arrows += 1,
                        None => {}
                    }
                }
            }
            let width = (edges_count + up_arrows).max(new_edges + down_arrows) as f64;
            let weight = 2.0 / (n as f64 * (K + 1.0)) * (1.0 + (K - 1.0) * i as f64 / (n as f64 - 1.0));
            sum += width * weight;
            sum_sq += width * width * weight;
            edges_count = new_edges;
        }
        let deviation = (sum_sq - sum * sum).max(0.0).sqrt();
        (sum + deviation).round() as usize
    }
}
