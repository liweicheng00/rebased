//! The write operations: the operation list, the Undo steps of each operation, and the Local History
//! versions that an operation keeps before it can lose local changes.

use crate::{err, history, OpOutcome, Result, Service};
use rebased_git::changelist::PartialFile;
use rebased_git::merge::Side;
use rebased_git::ops::{OpResult, PlanEntry, ResetMode, UndoAction, UndoMode};
use rebased_git::remote::UpdateMode;
use rebased_git::review::FinishMode;
use rebased_git::Repo;
use serde::Deserialize;
use std::path::PathBuf;

/// A write operation.
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Op {
    Checkout { target: String, kind: String },
    CreateBranch { name: String, at: String, checkout: bool },
    CreateTag { name: String, at: String, #[serde(default)] message: String },
    RenameBranch { from: String, to: String },
    DeleteBranch { name: String, force: bool },
    DeleteTag { name: String },
    Merge { rev: String },
    Rebase { onto: String },
    CherryPick { oids: Vec<String> },
    Revert { oids: Vec<String> },
    Reset { to: String, mode: ResetMode },
    Continue,
    Abort,
    MarkResolved { paths: Vec<String> },
    Rewrite { base: String, plan: Vec<PlanEntry>, what: String },
    Undo { actions: Vec<UndoAction> },
    AddWorktree { path: String, branch: String, new_branch: bool, at: String },
    RemoveWorktree { path: String, force: bool },
    PruneWorktrees,
    Commit {
        paths: Vec<String>,
        #[serde(default)]
        unversioned: Vec<String>,
        #[serde(default)]
        partial: Vec<PartialFile>,
        /// Files in more than one changelist: the hunks to commit.
        #[serde(default)]
        hunks: Vec<HunkSelection>,
        message: String,
        /// Add "Signed-off-by" with the committer, as `git commit -s`.
        #[serde(default)]
        sign_off: bool,
        #[serde(default)]
        amend: bool,
    },
    Rollback { paths: Vec<String> },
    AddFiles { paths: Vec<String> },
    DeleteUnversioned { paths: Vec<String> },
    Push { branch: String, remote: String, remote_branch: String, #[serde(default)] force: bool, #[serde(default)] set_upstream: bool, #[serde(default)] tags: bool },
    Update { mode: UpdateMode },
    StashPush { #[serde(default)] message: String, #[serde(default)] paths: Vec<String>, #[serde(default)] include_untracked: bool, #[serde(default)] keep_index: bool },
    StashApply { index: usize, #[serde(default)] pop: bool, #[serde(default)] restore_index: bool },
    StashDrop { index: usize },
    StashBranch { index: usize, branch: String },
    ResolveText { path: String, text: String },
    ResolveSide { paths: Vec<String>, side: Side },
    ApplyFileChanges { from: String, to: String, paths: Vec<String>, #[serde(default)] reverse: bool },
    GetFromRevision { rev: String, paths: Vec<String> },
    AddRemote { name: String, url: String },
    RemoveRemote { name: String },
    RenameRemote { from: String, to: String },
    SetRemoteUrl { name: String, url: String, #[serde(default)] push_url: String },
    FetchRemote { name: String },
    PushTag { remote: String, tag: String },
    PushAllTags { remote: String },
    /// Deletes a branch or a tag on a remote; `name` is a full ref.
    DeleteRemoteRef { remote: String, name: String },
    /// Deletes the local branches whose work is on their tracked branch, except the kept ones.
    /// `expected` is the list that the user saw; a changed list deletes nothing.
    DeleteMerged { upstreams: Vec<String>, #[serde(default)] keep: Vec<String>, expected: Vec<String> },
    /// Deletes the chosen branches that are merged into `target`, as `git branch --merged`.
    DeleteMergedInto { target: String, names: Vec<String> },
    /// Puts a reviewed branch into its base: Merge, Squash, or Rebase and fast-forward.
    FinishReview { branch: String, mode: FinishMode, #[serde(default)] message: String, #[serde(default)] delete_branch: bool },
    /// Sets the tracked branch; no upstream stops the tracking.
    SetUpstream { branch: String, upstream: Option<String> },
    /// Rolls back the hunks of one changelist of a file that is in more than one changelist.
    RollbackHunks { path: String, ids: Vec<String> },
    /// Initializes the submodules and checks out their recorded commits. No paths means all submodules.
    UpdateSubmodules { #[serde(default)] paths: Vec<String> },
    /// Writes a Local History version back to the working tree. No blob deletes the file.
    RevertLocalHistory { path: String, blob: Option<String> },
}

#[derive(Deserialize)]
pub struct HunkSelection {
    pub path: String,
    pub ids: Vec<String>,
}

/// The files whose local changes an operation can lose, and the Local History label for them.
fn at_risk(repo: &Repo, op: &Op) -> Option<(&'static str, Vec<PathBuf>)> {
    let files = |paths: &[String]| paths.iter().map(PathBuf::from).collect::<Vec<_>>();
    let (label, paths) = match op {
        Op::Rollback { paths } => ("Before Rollback", files(paths)),
        Op::RollbackHunks { path, .. } => ("Before Rollback", files(std::slice::from_ref(path))),
        Op::DeleteUnversioned { paths } => ("Before Delete", files(paths)),
        Op::GetFromRevision { paths, .. } => ("Before Get from Revision", files(paths)),
        Op::ApplyFileChanges { paths, .. } => ("Before Apply Changes", files(paths)),
        Op::ResolveText { path, .. } => ("Before Resolve", files(std::slice::from_ref(path))),
        Op::ResolveSide { paths, .. } => ("Before Resolve", files(paths)),
        Op::StashPush { paths, .. } if !paths.is_empty() => ("Before Stash", files(paths)),
        Op::StashPush { .. } | Op::Reset { mode: ResetMode::Hard, .. } => {
            let label = if matches!(op, Op::StashPush { .. }) { "Before Stash" } else { "Before Hard Reset" };
            let out = repo.git(&["diff", "--name-only", "-z", "HEAD"]).ok()?;
            let changed: Vec<PathBuf> =
                out.split(|&b| b == 0).filter(|p| !p.is_empty()).map(|p| PathBuf::from(String::from_utf8_lossy(p).into_owned())).collect();
            (label, changed)
        }
        _ => return None,
    };
    (!paths.is_empty() && paths.len() <= history::MAX_BULK_FILES * 5).then_some((label, paths))
}

/// What Undo must do for an operation, from the state before it.
enum UndoPlan {
    None,
    /// Move the branch back to the HEAD before the operation.
    MoveBack(UndoMode),
    /// Go back to the branch or commit before; `created` is a local branch that the checkout created.
    Checkout { created: Option<String> },
    CreatedBranch { name: String, checkout: bool },
    CreatedTag { name: String },
    Renamed { from: String, to: String },
    DeletedRef { name: String, oid: String },
    DroppedStash { oid: String, message: String },
}

fn raw_ref(repo: &Repo, name: &str) -> Option<String> {
    repo.git(&["rev-parse", "-q", "--verify", name]).ok().map(|b| String::from_utf8_lossy(&b).trim().to_string()).filter(|s| !s.is_empty())
}

impl UndoPlan {
    fn before(repo: &Repo, op: &Op) -> UndoPlan {
        match op {
            Op::Checkout { target, kind } => {
                let local = target.split_once('/').map_or(target.as_str(), |(_, b)| b);
                let created = (kind == "remote" && raw_ref(repo, &format!("refs/heads/{local}")).is_none()).then(|| local.to_string());
                UndoPlan::Checkout { created }
            }
            Op::CreateBranch { name, checkout, .. } => UndoPlan::CreatedBranch { name: name.clone(), checkout: *checkout },
            Op::CreateTag { name, .. } => UndoPlan::CreatedTag { name: name.clone() },
            Op::RenameBranch { from, to } => UndoPlan::Renamed { from: from.clone(), to: to.clone() },
            Op::DeleteBranch { name, .. } | Op::DeleteTag { name } => {
                let full = if matches!(op, Op::DeleteTag { .. }) { format!("refs/tags/{name}") } else { format!("refs/heads/{name}") };
                // A tag keeps its tag object, so an annotated tag comes back with its message.
                raw_ref(repo, &full).map_or(UndoPlan::None, |oid| UndoPlan::DeletedRef { name: full, oid })
            }
            Op::Merge { .. } | Op::Rebase { .. } | Op::CherryPick { .. } | Op::Revert { .. } | Op::Update { .. } | Op::Continue => {
                UndoPlan::MoveBack(UndoMode::Keep)
            }
            Op::Reset { mode, .. } => UndoPlan::MoveBack(match mode {
                ResetMode::Soft | ResetMode::Mixed => UndoMode::Mixed,
                ResetMode::Hard | ResetMode::Keep => UndoMode::Keep,
            }),
            Op::StashDrop { index } => repo
                .stashes()
                .ok()
                .and_then(|l| l.into_iter().find(|s| s.index == *index))
                .map_or(UndoPlan::None, |s| UndoPlan::DroppedStash { oid: s.oid, message: s.message }),
            _ => UndoPlan::None,
        }
    }

    fn actions(self, repo: &Repo, pre_head: Option<String>, pre_branch: Option<String>) -> Vec<UndoAction> {
        let post = repo.resolve("HEAD").unwrap_or_default();
        let back = || match (&pre_branch, &pre_head) {
            (Some(b), _) => Some(UndoAction::Checkout { target: b.clone(), detach: false, expected_head: post.clone() }),
            (None, Some(h)) => Some(UndoAction::Checkout { target: h.clone(), detach: true, expected_head: post.clone() }),
            _ => None,
        };
        let delete = |full: String| raw_ref(repo, &full).map(|expected| UndoAction::DeleteRef { name: full, expected });
        match self {
            UndoPlan::None => Vec::new(),
            UndoPlan::MoveBack(mode) => match pre_head {
                Some(h) if h != post && !post.is_empty() => vec![UndoAction::Reset { to: h, expected_head: post, mode }],
                _ => Vec::new(),
            },
            UndoPlan::Checkout { created } => {
                back().into_iter().chain(created.and_then(|c| delete(format!("refs/heads/{c}")))).collect()
            }
            UndoPlan::CreatedBranch { name, checkout } => {
                let first = if checkout { back() } else { None };
                first.into_iter().chain(delete(format!("refs/heads/{name}"))).collect()
            }
            UndoPlan::CreatedTag { name } => delete(format!("refs/tags/{name}")).into_iter().collect(),
            UndoPlan::Renamed { from, to } => vec![UndoAction::RenameBranch { from: to, to: from }],
            UndoPlan::DeletedRef { name, oid } => vec![UndoAction::CreateRef { name, oid }],
            UndoPlan::DroppedStash { oid, message } => vec![UndoAction::StashStore { oid, message }],
        }
    }
}

impl Service {
    /// Runs a write operation, then reloads commits and refs. A failed operation still reloads,
    /// because git can stop halfway (for example at a conflict).
    pub fn run_op(&self, op: Op) -> Result<OpOutcome> {
        let (root, history) = self.with(|s| Ok((s.repo.root.clone(), s.history.clone())))?;
        let repo = Repo::open(&root).map_err(err)?;
        if let Some((label, paths)) = at_risk(&repo, &op) {
            history.record(&paths, label);
        }
        let plan = UndoPlan::before(&repo, &op);
        let pre_head = repo.resolve("HEAD");
        let pre_branch = repo.state().ok().and_then(|s| s.branch);
        // Operations that can change the recorded commit of a submodule without checking it out.
        let moves_head = matches!(
            op,
            Op::Checkout { .. }
                | Op::CreateBranch { checkout: true, .. }
                | Op::Merge { .. }
                | Op::Rebase { .. }
                | Op::CherryPick { .. }
                | Op::Revert { .. }
                | Op::Reset { .. }
                | Op::Continue
                | Op::Abort
                | Op::Undo { .. }
                | Op::Update { .. }
                | Op::FinishReview { .. }
        );
        let result = match op {
            Op::Checkout { target, kind } => repo.checkout(&target, &kind),
            Op::CreateBranch { name, at, checkout } => repo.create_branch(&name, &at, checkout),
            Op::CreateTag { name, at, message } => repo.create_tag(&name, &at, &message),
            Op::RenameBranch { from, to } => repo.rename_branch(&from, &to),
            Op::DeleteBranch { name, force } => repo.delete_branch(&name, force),
            Op::DeleteTag { name } => repo.delete_tag(&name),
            Op::Merge { rev } => repo.merge(&rev),
            Op::Rebase { onto } => repo.rebase(&onto),
            Op::CherryPick { oids } => repo.cherry_pick(&oids),
            Op::Revert { oids } => repo.revert(&oids),
            Op::Reset { to, mode } => repo.reset(&to, mode),
            Op::Continue => repo.continue_or_abort(false),
            Op::Abort => repo.continue_or_abort(true),
            Op::MarkResolved { paths } => repo.mark_resolved(&paths),
            Op::Rewrite { base, plan, what } => repo.rewrite(&base, &plan, &what),
            Op::Undo { actions } => repo.apply_undo(&actions),
            Op::AddWorktree { path, branch, new_branch, at } => {
                repo.add_worktree(&path, &branch, new_branch, &at).map(|_| OpResult::ok_msg(format!("Added worktree {path}")))
            }
            Op::RemoveWorktree { path, force } => {
                repo.remove_worktree(&path, force).map(|_| OpResult::ok_msg(format!("Removed worktree {path}")))
            }
            Op::PruneWorktrees => repo.prune_worktrees().map(|_| OpResult::ok_msg("Pruned stale worktrees")),
            Op::Commit { paths, unversioned, mut partial, hunks, message, sign_off, amend } => {
                let message = if sign_off { repo.with_sign_off(&message).map_err(err)? } else { message };
                for h in hunks {
                    let content = repo.content_with_hunks(&h.path, &h.ids).map_err(err)?;
                    partial.push(PartialFile { path: h.path, content });
                }
                if partial.is_empty() {
                    repo.commit_paths(&paths, &unversioned, &message, amend)
                } else {
                    repo.commit_partial(&paths, &unversioned, &partial, &message, amend)
                }
            }
            Op::Rollback { paths } => repo.rollback(&paths),
            Op::AddFiles { paths } => repo.add_files(&paths),
            Op::DeleteUnversioned { paths } => repo.delete_unversioned(&paths),
            Op::Push { branch, remote, remote_branch, force, set_upstream, tags } => {
                repo.push(&branch, &remote, &remote_branch, force, set_upstream, tags)
            }
            Op::Update { mode } => repo.update(mode),
            Op::StashPush { message, paths, include_untracked, keep_index } => repo.stash_push(&message, &paths, include_untracked, keep_index),
            Op::StashApply { index, pop, restore_index } => repo.stash_apply(index, pop, restore_index),
            Op::StashDrop { index } => repo.stash_drop(index),
            Op::StashBranch { index, branch } => repo.stash_branch(index, &branch),
            Op::ResolveText { path, text } => repo.resolve_with_text(&path, &text),
            Op::ResolveSide { paths, side } => repo.resolve_with_side(&paths, side),
            Op::ApplyFileChanges { from, to, paths, reverse } => repo.apply_file_changes(&from, &to, &paths, reverse),
            Op::GetFromRevision { rev, paths } => repo.get_from_revision(&rev, &paths),
            Op::UpdateSubmodules { paths } => repo.update_submodules(&paths),
            Op::AddRemote { name, url } => repo.add_remote(&name, &url),
            Op::RemoveRemote { name } => repo.remove_remote(&name),
            Op::RenameRemote { from, to } => repo.rename_remote(&from, &to),
            Op::SetRemoteUrl { name, url, push_url } => repo.set_remote_url(&name, &url, &push_url),
            Op::FetchRemote { name } => repo.fetch_remote(&name),
            Op::PushTag { remote, tag } => repo.push_tag(&remote, &tag),
            Op::PushAllTags { remote } => repo.push_all_tags(&remote),
            Op::DeleteRemoteRef { remote, name } => repo.delete_remote_ref(&remote, &name),
            Op::SetUpstream { branch, upstream } => repo.set_upstream(&branch, upstream.as_deref()),
            Op::FinishReview { branch, mode, message, delete_branch } => repo.finish_review(&branch, mode, &message, delete_branch),
            Op::DeleteMergedInto { target, names } => repo.delete_merged_into(&target, &names),
            Op::DeleteMerged { upstreams, keep, expected } => repo.delete_merged(&upstreams, &keep, &expected),
            Op::RollbackHunks { path, ids } => repo.rollback_hunks(&path, &ids),
            Op::RevertLocalHistory { path, blob } => history
                .revert(&path, blob.as_deref())
                .map(|_| OpResult::ok_msg(format!("Reverted {path} to the Local History version")))
                .map_err(rebased_git::GitError),
        };
        let mut result = match result {
            Ok(r) => r,
            Err(e) => OpResult { ok: false, message: e.to_string(), conflicts: Vec::new(), undo: Vec::new() },
        };
        if result.ok && result.undo.is_empty() {
            result.undo = plan.actions(&repo, pre_head.clone(), pre_branch);
        }
        let view = self.refresh_at(&root)?;
        let head = view.head_oid.clone();
        let stale_submodules = if moves_head && head != pre_head {
            repo.submodules()
                .unwrap_or_default()
                .into_iter()
                .filter(|s| s.state == rebased_git::submodule::SubmoduleState::OtherCommit && !s.dirty)
                .map(|s| s.path)
                .collect()
        } else {
            Vec::new()
        };
        let error_kind = (!result.ok).then(|| {
            if result.conflicts.is_empty() {
                crate::errors::classify(&result.message)
            } else {
                crate::errors::ErrorKind::Conflict
            }
        });
        Ok(OpOutcome { result, view, head, stale_submodules, error_kind })
    }
}
