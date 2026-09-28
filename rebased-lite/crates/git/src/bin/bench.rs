//! Loads a repository, lays out the graph and prints timings. Usage: bench <repo> [--no-sort]
use rebased_git::Repo;
use rebased_graph::GraphOptions;
use std::time::Instant;

fn rss_mb() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| s.lines().find(|l| l.starts_with("VmHWM")).map(|l| l.split_whitespace().nth(1).unwrap().parse::<u64>().unwrap() / 1024))
        .unwrap_or(0)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let repo = Repo::open(std::path::Path::new(&args[1])).expect("open");
    let opts = GraphOptions { intelli_sort: !args.iter().any(|a| a == "--no-sort"), show_long_edges: false };
    let t = Instant::now();
    let topo = repo.load_topology().expect("load");
    let t_load = t.elapsed();
    let t = Instant::now();
    let graph = repo.build_graph(&topo, &opts);
    let t_graph = t.elapsed();
    let printer = graph.printer();
    let t = Instant::now();
    let mut elements = 0usize;
    let mut max_pos = 0usize;
    for row in 0..graph.row_count() {
        let els = printer.print_elements(row);
        elements += els.len();
        max_pos = max_pos.max(els.iter().map(|e| e.pos()).max().unwrap_or(0));
    }
    let t_rows = t.elapsed();
    println!(
        "commits={} load={:?} layout+sort={:?} all_rows={:?} ({:.1}us/row) elements={} max_col={} width={} peak_rss={}MB",
        graph.row_count(), t_load, t_graph, t_rows,
        t_rows.as_secs_f64() * 1e6 / graph.row_count().max(1) as f64,
        elements, max_pos, printer.recommended_width(), rss_mb()
    );
    for row in 0..graph.row_count().min(8) {
        let node = graph.node_at_row(row);
        let labels: Vec<String> = topo.ref_labels(node).into_iter().map(|r| r.name).collect();
        println!("row {row}: {} {:?} cols={}", &topo.oid_hex(node)[..10], labels, printer.print_elements(row).iter().map(|e| e.pos()).max().unwrap_or(0) + 1);
    }
}
