//! The arguments and the results of the commands.

use rebased_git::ops::OpResult;
use rebased_git::{Change, CommitFull, FileContent, LogFilter, RefLabel};
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ViewArgs {
    #[serde(default = "yes")]
    pub intelli_sort: bool,
    pub show_long_edges: bool,
    pub filter: LogFilter,
    /// Collapse every linear branch after the graph is built.
    pub collapse_linear: bool,
}

pub(crate) fn yes() -> bool {
    true
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenArgs {
    pub path: String,
    #[serde(flatten)]
    pub view: ViewArgs,
}

#[derive(Serialize)]
#[derive(ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ViewResult {
    pub root: String,
    pub head: Option<String>,
    pub head_oid: Option<String>,
    pub total_commits: usize,
    pub row_count: usize,
    pub filtered: bool,
    pub collapsed: bool,
    pub recommended_width: usize,
    pub load_ms: u128,
}

/// One drawing element. `k`: n=node, e=edge. `d`: u/d direction. `j`: row an arrow jumps to.
#[derive(Serialize)]
#[derive(ts_rs::TS)]
#[ts(export)]
pub struct El {
    #[ts(type = "\"n\" | \"e\"")]
    pub k: char,
    pub p: usize,
    pub o: usize,
    #[ts(type = "\"u\" | \"d\"")]
    pub d: char,
    pub a: bool,
    pub t: bool,
    pub s: bool,
    pub c: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub j: Option<usize>,
    /// Rows (upper, lower) of a collapsed fragment; clicking the edge expands it.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub x: Option<[usize; 2]>,
}

#[derive(Serialize)]
#[derive(ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub row: usize,
    pub oid: String,
    pub refs: Vec<RefLabel>,
    pub subject: String,
    pub author: String,
    pub author_email: String,
    pub author_time: i64,
    pub is_head: bool,
    pub elements: Vec<El>,
}

#[derive(Deserialize)]
pub struct RowsArgs {
    pub start: usize,
    pub end: usize,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub enum RevSpec {
    Commit(String),
    ParentOf(String),
    Worktree,
}

#[derive(Deserialize)]
pub struct CompareArgs {
    pub left: RevSpec,
    pub right: RevSpec,
}

#[derive(Deserialize)]
pub struct CompareRefsArgs {
    pub left: String,
    pub right: String,
}

#[derive(Serialize)]
#[derive(ts_rs::TS)]
#[ts(export)]
pub struct CompareResult {
    pub changes: Vec<Change>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePairArgs {
    pub left: RevSpec,
    pub right: RevSpec,
    pub path: String,
    pub old_path: Option<String>,
}

#[derive(Serialize)]
#[derive(ts_rs::TS)]
#[ts(export)]
pub struct FilePair {
    pub left: FileContent,
    pub right: FileContent,
}

#[derive(Deserialize)]
pub struct OidArgs {
    pub oid: String,
}

#[derive(Deserialize)]
pub struct FindArgs {
    pub query: String,
}

#[derive(Serialize)]
#[derive(ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct FindResult {
    pub oid: Option<String>,
    /// Row in the current view; `None` when the commit is hidden by the filter or unknown.
    pub row: Option<usize>,
    /// The new row count when finding the commit expanded a collapsed branch.
    pub row_count: Option<usize>,
}

#[derive(Deserialize)]
pub struct CollapseArgs {
    pub mode: String,
    pub row: Option<usize>,
    pub up: Option<usize>,
    pub down: Option<usize>,
}

#[derive(Deserialize)]
pub struct PathArgs {
    pub path: String,
}

#[derive(Deserialize)]
pub struct BlobArgs {
    pub blob: Option<String>,
}

#[derive(Deserialize)]
pub struct BlameArgs {
    pub path: String,
    pub rev: RevSpec,
}

#[derive(Deserialize)]
pub struct IndexArgs {
    pub index: usize,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct PushInfoArgs {
    pub branch: Option<String>,
}

#[derive(Serialize)]
#[derive(ts_rs::TS)]
#[ts(export)]
pub struct OpOutcome {
    pub result: OpResult,
    pub view: ViewResult,
    pub head: Option<String>,
    /// Submodules whose checked-out commit is not the recorded commit after an operation that moved HEAD.
    #[serde(rename = "staleSubmodules")]
    pub stale_submodules: Vec<String>,
    /// The kind of the failure when the operation did not succeed.
    #[serde(rename = "errorKind", skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error_kind: Option<crate::errors::ErrorKind>,
}

#[derive(Serialize)]
#[derive(ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    #[serde(flatten)]
    pub commit: CommitFull,
    pub refs: Vec<RefLabel>,
}
