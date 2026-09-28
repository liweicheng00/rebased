//! Conformance tests against the golden files of IntelliJ Community
//! `platform/vcs-log/graph/testData` (Apache-2.0). The parsers and string formats are ports of
//! LinearGraphParser, CommitParser, GraphStrUtils and StrUtils.kt.

use rebased_graph::bek::{bek_map, SortedLinearGraph};
use rebased_graph::layout;
use rebased_graph::linear::*;
use rebased_graph::print::*;
use std::collections::HashMap;

fn load(dir: &str, name: &str) -> (String, String) {
    let base = format!("{}/tests/data/{dir}/{name}", env!("CARGO_MANIFEST_DIR"));
    let read = |s: &str| std::fs::read_to_string(format!("{base}{s}")).unwrap().replace("\r\n", "\n");
    (read("_in.txt"), read("_out.txt"))
}

fn lines(s: &str) -> impl Iterator<Item = &str> {
    s.split('\n').filter(|l| !l.is_empty())
}

// ---- LinearGraphParser ----

struct TestGraph {
    types: Vec<NodeType>,
    edges: HashMap<usize, Vec<Edge>>, // insertion order per node: up edges first (by creation), then own edges
    up: HashMap<usize, Vec<Edge>>,
    down: HashMap<usize, Vec<Edge>>,
}

fn edge_type(c: char) -> EdgeType {
    match c {
        'U' => EdgeType::Usual,
        'D' => EdgeType::Dotted,
        'N' => EdgeType::NotLoadCommit,
        'P' => EdgeType::DottedArrowUp,
        'O' => EdgeType::DottedArrowDown,
        _ => panic!("edge type {c}"),
    }
}

fn node_type(c: char) -> NodeType {
    match c {
        'U' => NodeType::Usual,
        'G' => NodeType::Unmatched,
        'N' => NodeType::NotLoadCommit,
        _ => panic!("node type {c}"),
    }
}

fn num_char(s: &str) -> (i32, char) {
    (s[..s.len() - 2].parse().unwrap(), s.chars().last().unwrap())
}

fn parse_linear(input: &str) -> TestGraph {
    let mut types = Vec::new();
    let mut raw: Vec<Vec<String>> = Vec::new();
    let mut id_to_index = HashMap::new();
    for line in lines(input) {
        let sep = line.find("|-").unwrap();
        let (id, t) = num_char(&line[..sep]);
        id_to_index.insert(id, types.len());
        types.push(node_type(t));
        raw.push(line[sep + 2..].split_whitespace().map(String::from).collect());
    }
    let mut up: HashMap<usize, Vec<Edge>> = HashMap::new();
    let mut down: HashMap<usize, Vec<Edge>> = HashMap::new();
    for (node, es) in raw.iter().enumerate() {
        for s in es {
            let (target, c) = num_char(s);
            let ty = edge_type(c);
            let e = if ty.is_normal() {
                Edge::normal(node, id_to_index[&target], ty)
            } else {
                Edge::with_target(node, Some(target), ty)
            };
            if let Some(u) = e.up {
                down.entry(u).or_default().push(e);
            }
            if let Some(d) = e.down {
                up.entry(d).or_default().push(e);
            }
        }
    }
    TestGraph { types, edges: HashMap::new(), up, down }
}

impl LinearGraph for TestGraph {
    fn nodes_count(&self) -> usize {
        self.types.len()
    }
    fn node_type(&self, node: usize) -> NodeType {
        self.types[node]
    }
    fn adjacent_edges(&self, node: usize, f: EdgeFilter) -> Vec<Edge> {
        let _ = &self.edges;
        let mut r = Vec::new();
        for e in self.up.get(&node).into_iter().flatten() {
            if (e.ty.is_normal() && f.up_normal) || (!e.ty.is_normal() && f.special) {
                r.push(*e);
            }
        }
        for e in self.down.get(&node).into_iter().flatten() {
            if (e.ty.is_normal() && f.down_normal) || (!e.ty.is_normal() && f.special) {
                r.push(*e);
            }
        }
        r
    }
    fn node_id(&self, node: usize) -> i32 {
        node as i32
    }
    fn node_index(&self, id: i32) -> Option<usize> {
        (id >= 0 && (id as usize) < self.types.len()).then_some(id as usize)
    }
}

// ---- string formats ----

fn edge_char(t: EdgeType) -> char {
    match t {
        EdgeType::Usual => 'U',
        EdgeType::Dotted => 'D',
        EdgeType::NotLoadCommit => 'N',
        EdgeType::DottedArrowUp => 'P',
        EdgeType::DottedArrowDown => 'O',
    }
}

fn node_char(t: NodeType) -> char {
    match t {
        NodeType::Usual => 'U',
        NodeType::Unmatched => 'G',
        NodeType::NotLoadCommit => 'N',
    }
}

fn opt(v: Option<impl ToString>) -> String {
    v.map(|x| x.to_string()).unwrap_or_else(|| "n".into())
}

fn edge_str(e: &Edge) -> String {
    format!("{}:{}:{}_{}", opt(e.up), opt(e.down), opt(e.target), edge_char(e.ty))
}

fn linear_str(g: &impl LinearGraph) -> String {
    (0..g.nodes_count())
        .map(|n| {
            let es: Vec<String> = g.adjacent_edges(n, EdgeFilter::ALL).iter().map(edge_str).collect();
            format!("{}_{}|-{}", n, node_char(g.node_type(n)), es.join(" "))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

// ---- graphBuilder ----

fn parse_commits(input: &str) -> Vec<GraphCommit<String>> {
    lines(input)
        .map(|l| {
            let sep = l.find("|-").unwrap();
            GraphCommit { id: l[..sep].to_string(), parents: l[sep + 2..].split_whitespace().map(String::from).collect() }
        })
        .collect()
}

fn graph_builder(name: &str) {
    let (i, o) = load("graphBuilder", name);
    let commits = parse_commits(&i);
    let g = PermanentLinearGraph::build(&commits, |id| -i32::from_str_radix(id, 16).unwrap());
    assert_eq!(linear_str(&g), o.trim_end_matches('\n'), "graphBuilder/{name}");
}

#[test]
fn graph_builder_all() {
    for n in ["simple", "manyNodes", "manyUpNodes", "manyDownNodes", "oneNode", "oneNodeNotFullGraph", "notFullGraph", "parentsOrder", "duplicateParents"] {
        graph_builder(n);
    }
}

// ---- layoutBuilder ----

fn layout_builder(name: &str) {
    let (i, o) = load("layoutBuilder", name);
    let commits = parse_commits(&i);
    let g = PermanentLinearGraph::build(&commits, |_| i32::MIN);
    let l = layout::build(&g, &[], |a, b| commits[a].id.cmp(&commits[b].id));
    let actual: Vec<String> = (0..g.nodes_count()).map(|n| format!("{}|-{}", l.layout_index(n), l.one_of_head_node(n))).collect();
    assert_eq!(actual.join("\n"), o.trim_end_matches('\n'), "layoutBuilder/{name}");
}

#[test]
fn layout_builder_all() {
    for n in ["manyNodes", "notFullGraph", "oneNode", "oneNodeNotFullGraph", "headsOrder"] {
        layout_builder(n);
    }
}

#[test]
fn layout_head_order() {
    // GraphLayoutBuilderHeadOrderTest.branchingGraph
    let commits: Vec<GraphCommit<i32>> = [(0, vec![2]), (1, vec![3]), (2, vec![3]), (3, vec![4]), (4, vec![])]
        .into_iter()
        .map(|(id, p)| GraphCommit { id, parents: p })
        .collect();
    let g = PermanentLinearGraph::build(&commits, |_| i32::MIN);
    let cases: [(&[usize], [usize; 5]); 6] = [
        (&[0, 1, 2], [0, 1, 0, 0, 0]),
        (&[0, 2, 1], [0, 1, 0, 0, 0]),
        (&[1, 0, 2], [0, 1, 0, 1, 1]),
        (&[1, 2, 0], [0, 1, 2, 1, 1]),
        (&[2, 0, 1], [0, 1, 2, 2, 2]),
        (&[2, 1, 0], [0, 1, 2, 2, 2]),
    ];
    for (order, expected) in cases {
        let pos = |x: usize| order.iter().position(|&o| o == x).map(|p| p as i64).unwrap_or(-1);
        let l = layout::build(&g, &[0, 2], |a, b| pos(a).cmp(&pos(b)));
        let heads: Vec<usize> = (0..5).map(|n| l.one_of_head_node(n)).collect();
        assert_eq!(heads, expected, "order {order:?}");
    }
}

// ---- edgesInRow ----

fn elem_cmp_zero() -> ElementComparator<fn(usize) -> i32> {
    ElementComparator { layout_index: |_| 0 }
}

#[test]
fn edges_in_row_all() {
    for name in ["simple", "manyNodes", "manyUpNodes", "manyDownNodes", "oneNode", "oneNodeNotFullGraph", "notFullGraph", "notLoadNode", "longGraph"] {
        let (i, o) = load("edgesInRow", name);
        let g = parse_linear(&i);
        let cmp = elem_cmp_zero();
        let actual: Vec<String> = (0..g.nodes_count())
            .map(|r| {
                let mut es: Vec<Element> = edges_in_row(&g, r).into_iter().map(Element::Edge).collect();
                if es.is_empty() {
                    return "none".to_string();
                }
                es.sort_by(|a, b| cmp.compare(a, b));
                es.iter()
                    .map(|e| match e {
                        Element::Edge(e) => format!("{}_{}_{}", opt(e.up), opt(e.down), edge_char(e.ty)),
                        _ => unreachable!(),
                    })
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .collect();
        assert_eq!(actual.join("\n"), o.trim_end_matches('\n'), "edgesInRow/{name}");
    }
}

// ---- elementGenerator ----

fn color_of(e: &Element) -> i32 {
    match e {
        Element::Node(n) => *n as i32,
        Element::Edge(e) => match e.as_normal() {
            Some((u, d)) => (u + d) as i32,
            None => e.not_null_node() as i32,
        },
    }
}

fn print_str(g: &TestGraph, gen: &PrintElementGenerator<&TestGraph, impl Fn(usize) -> i32>) -> String {
    let dir_ord = |d: Direction| if d == Direction::Up { 0 } else { 1 };
    (0..g.nodes_count())
        .map(|row| {
            let mut els = gen.print_elements(row);
            els.sort_by_key(|p| match *p {
                PrintElement::Node { pos, .. } => 1024 * pos,
                PrintElement::Edge { pos, dir, other_pos, .. } => 1024 * pos + (dir_ord(dir) + 1) * 64 + other_pos,
            });
            els.iter()
                .map(|p| match *p {
                    PrintElement::Node { row, pos, node } => {
                        format!("Node|-{row}:{pos}|-{}:Unselect({node}_{})", color_of(&p.element()), node_char(g.node_type(node)))
                    }
                    PrintElement::Edge { row, pos, other_pos, dir, arrow, edge, .. } => format!(
                        "Edge:{}{}:{}|-{row}:{pos}:{other_pos}|-{}:Unselect({})",
                        if dir == Direction::Up { "UP" } else { "DOWN" },
                        if arrow { "_ARROW" } else { "" },
                        if line_style(edge.ty) == LineStyle::Solid { "SOLID" } else { "DASHED" },
                        color_of(&p.element()),
                        edge_str(&edge)
                    ),
                })
                .collect::<Vec<_>>()
                .join("\n  ")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn element_generator(name: &str, limits: EdgeLimits) {
    let (i, o) = load("elementGenerator", name);
    let g = parse_linear(&i);
    let l = layout::build(&g, &[], |a, b| a.cmp(&b));
    let gen = PrintElementGenerator::new(&g, |n| l.layout_index(n), limits);
    assert_eq!(print_str(&g, &gen), o.trim_end_matches('\n'), "elementGenerator/{name}");
}

#[test]
fn element_generator_all() {
    let lim = |long, part, arrow| EdgeLimits { long_edge_size: long, visible_part_size: part, edge_with_arrow_size: arrow };
    for n in ["oneNode", "manyNodes", "longEdges", "specialElements"] {
        element_generator(n, lim(7, 2, 10));
    }
    element_generator("oneUpOneDown1", lim(7, 1, 10));
    element_generator("oneUpOneDown2", lim(10, 1, 10));
}

// ---- BekTest ----

fn test_graph(spec: &[(i32, &[i32])]) -> (TestGraph, Vec<i32>) {
    // TestGraphBuilder: node ids map to declaration order
    let idx: HashMap<i32, usize> = spec.iter().enumerate().map(|(i, (id, _))| (*id, i)).collect();
    let mut up: HashMap<usize, Vec<Edge>> = HashMap::new();
    let mut down: HashMap<usize, Vec<Edge>> = HashMap::new();
    for (i, (_, ps)) in spec.iter().enumerate() {
        for p in ps.iter() {
            let e = Edge::normal(i, idx[p], EdgeType::Usual);
            down.entry(e.up.unwrap()).or_default().push(e);
            up.entry(e.down.unwrap()).or_default().push(e);
        }
    }
    (TestGraph { types: vec![NodeType::Usual; spec.len()], edges: HashMap::new(), up, down }, spec.iter().map(|s| s.0).collect())
}

fn bek_case(before: &[(i32, &[i32])], after: &[(i32, &[i32])]) {
    let (g, ids) = test_graph(before);
    let l = layout::build(&g, &[], |a, b| a.cmp(&b));
    let map = bek_map(&g, &l, |_| 0);
    let sorted = SortedLinearGraph { graph: &g, map: &map };
    let actual: Vec<i32> = (0..sorted.nodes_count()).map(|r| ids[sorted.node_id(r) as usize]).collect();
    let expected: Vec<i32> = after.iter().map(|a| a.0).collect();
    assert_eq!(actual, expected);
}

#[test]
fn bek_cases() {
    bek_case(&[(0, &[1, 3]), (1, &[4, 2]), (2, &[4, 3]), (3, &[]), (4, &[])], &[(0, &[]), (1, &[]), (2, &[]), (3, &[]), (4, &[])]);
    bek_case(
        &[(0, &[1, 2]), (1, &[3]), (2, &[4]), (3, &[5]), (4, &[5]), (5, &[])],
        &[(0, &[]), (2, &[]), (4, &[]), (1, &[]), (3, &[]), (5, &[])],
    );
    bek_case(&[(0, &[2]), (1, &[2]), (2, &[])], &[(1, &[]), (0, &[]), (2, &[])]);
    bek_case(
        &[(0, &[2, 3]), (1, &[4]), (2, &[4]), (3, &[5]), (4, &[6]), (5, &[6]), (6, &[])],
        &[(1, &[]), (0, &[]), (3, &[]), (5, &[]), (2, &[]), (4, &[]), (6, &[])],
    );
}
