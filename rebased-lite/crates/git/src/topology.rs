//! The commit graph of a repository: every commit with its parents and time, and the refs on each commit.

use crate::{hex, unhex, Repo, Result};
use rebased_graph::linear::GraphCommit;
use rebased_graph::{Graph, GraphOptions, RefInfo, RefKind};
use serde::Serialize;
use std::collections::HashMap;


#[derive(Clone, Debug, Serialize)]
#[derive(ts_rs::TS)]
#[ts(export)]
pub struct RefLabel {
    pub name: String,
    #[ts(type = "\"head\" | \"local\" | \"remote\" | \"tag\" | \"other\"")]
    pub kind: &'static str,
}


/// Commit topology in `--date-order`, plus refs. Oids are stored as raw bytes.
pub struct Topology {
    pub oids: Vec<[u8; 20]>,
    pub timestamps: Vec<i64>,
    pub parents: Vec<Vec<[u8; 20]>>,
    pub refs: Vec<Vec<RefInfo>>,
    pub head: Option<String>,
    index: HashMap<[u8; 20], usize>,
}

impl Topology {
    pub fn oid_hex(&self, node: usize) -> String {
        hex(&self.oids[node])
    }

    pub fn node_of(&self, oid_hex: &str) -> Option<usize> {
        self.index.get(&unhex(oid_hex)?).copied()
    }

    pub fn ref_labels(&self, node: usize) -> Vec<RefLabel> {
        let mut refs = self.refs[node].clone();
        refs.sort_by(|a, b| label_rank(a.kind).cmp(&label_rank(b.kind)).then_with(|| a.name.cmp(&b.name)));
        refs.into_iter()
            .map(|r| RefLabel {
                kind: match r.kind {
                    RefKind::Head => "head",
                    RefKind::CurrentBranch | RefKind::Master | RefKind::LocalBranch => "local",
                    RefKind::OriginMaster | RefKind::RemoteBranch => "remote",
                    RefKind::Tag => "tag",
                    RefKind::Other => "other",
                },
                name: r.name,
            })
            .collect()
    }
}

fn label_rank(k: RefKind) -> u8 {
    match k {
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

impl Repo {
    /// Same revision set as IntelliJ `GitLogUtil.LOG_ALL` plus `--date-order`.
    pub fn load_topology(&self) -> Result<Topology> {
        let head = self.git(&["symbolic-ref", "-q", "HEAD"]).ok().map(|b| String::from_utf8_lossy(&b).trim().to_string());
        let has_head = self.git(&["rev-parse", "-q", "--verify", "HEAD"]).is_ok();
        let mut args = vec!["log", "--date-order", "--format=%H %ct %P", "--branches", "--remotes", "--tags"];
        if has_head {
            args.insert(1, "HEAD");
        }
        let raw = self.git(&args)?;
        let text = String::from_utf8_lossy(&raw);

        let mut oids = Vec::new();
        let mut timestamps = Vec::new();
        let mut parents_hex: Vec<Vec<[u8; 20]>> = Vec::new();
        for line in text.lines() {
            let mut parts = line.split(' ');
            let (Some(oid), Some(ts)) = (parts.next(), parts.next()) else { continue };
            let Some(oid) = unhex(oid) else { continue };
            oids.push(oid);
            timestamps.push(ts.parse().unwrap_or(0));
            parents_hex.push(parts.filter_map(unhex).collect());
        }
        let index: HashMap<[u8; 20], usize> = oids.iter().enumerate().map(|(i, o)| (*o, i)).collect();

        let mut refs: Vec<Vec<RefInfo>> = vec![Vec::new(); oids.len()];
        let raw_refs = self.git(&[
            "for-each-ref",
            "--format=%(objectname) %(*objectname) %(refname)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ])?;
        for line in String::from_utf8_lossy(&raw_refs).lines() {
            let mut p = line.splitn(3, ' ');
            let (Some(obj), Some(peeled), Some(name)) = (p.next(), p.next(), p.next()) else { continue };
            let target = if peeled.is_empty() { obj } else { peeled };
            let Some(node) = unhex(target).and_then(|o| index.get(&o).copied()) else { continue };
            if name.ends_with("/HEAD") && name.starts_with("refs/remotes/") {
                continue;
            }
            refs[node].push(ref_info(name, head.as_deref()));
        }
        if has_head && head.is_none() {
            // Detached HEAD: show a HEAD label.
            if let Ok(b) = self.git(&["rev-parse", "HEAD"]) {
                if let Some(node) = unhex(String::from_utf8_lossy(&b).trim()).and_then(|o| index.get(&o).copied()) {
                    refs[node].push(RefInfo { name: "HEAD".into(), kind: RefKind::Head });
                }
            }
        }

        Ok(Topology { oids, timestamps, parents: parents_hex, refs, head, index })
    }

    pub fn build_graph(&self, topo: &Topology, options: &GraphOptions) -> Graph {
        let commits: Vec<GraphCommit<[u8; 20]>> =
            topo.oids.iter().zip(&topo.parents).map(|(id, parents)| GraphCommit { id: *id, parents: parents.clone() }).collect();
        Graph::build(&commits, &topo.timestamps, &topo.refs, options)
    }
}

fn ref_info(full: &str, head: Option<&str>) -> RefInfo {
    if let Some(n) = full.strip_prefix("refs/heads/") {
        let kind = if Some(full) == head {
            RefKind::CurrentBranch
        } else if n == "master" || n == "main" {
            RefKind::Master
        } else {
            RefKind::LocalBranch
        };
        return RefInfo { name: n.to_string(), kind };
    }
    if let Some(n) = full.strip_prefix("refs/remotes/") {
        let kind = if n == "origin/master" || n == "origin/main" { RefKind::OriginMaster } else { RefKind::RemoteBranch };
        return RefInfo { name: n.to_string(), kind };
    }
    if let Some(n) = full.strip_prefix("refs/tags/") {
        return RefInfo { name: n.to_string(), kind: RefKind::Tag };
    }
    RefInfo { name: full.to_string(), kind: RefKind::Other }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ref_kinds() {
        assert_eq!(ref_info("refs/heads/main", Some("refs/heads/dev")).kind, RefKind::Master);
        assert_eq!(ref_info("refs/heads/dev", Some("refs/heads/dev")).kind, RefKind::CurrentBranch);
        assert_eq!(ref_info("refs/remotes/origin/main", None).kind, RefKind::OriginMaster);
        assert_eq!(ref_info("refs/tags/v1", None).kind, RefKind::Tag);
    }
}
