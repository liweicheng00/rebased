//! The read commands.

use crate::{err, history, watch, BlameArgs, BlobArgs, CompareArgs, CompareRefsArgs, CompareResult, FilePair, FilePairArgs, IndexArgs, OidArgs, PathArgs, PushInfoArgs, Result, RevSpec, Service};
use rebased_git::changelist::{ChangeListOp, LocalChanges};
use rebased_git::history::{Blame, HistoryEntry};
use rebased_git::merge::MergeSides;
use rebased_git::ops::{RepoState, RewriteRange};
use rebased_git::remote::PushInfo;
use rebased_git::stash::{Stash, StashDetail};
use rebased_git::worktree::{RecentBranch, Worktree};
use rebased_git::{BranchInfo, Repo, Rev};

impl Service {
    pub fn refs(&self) -> Result<Vec<BranchInfo>> {
        self.with(|s| s.repo.list_refs().map_err(err))
    }

    pub fn worktrees(&self) -> Result<Vec<Worktree>> {
        self.with(|s| s.repo.worktrees().map_err(err))
    }

    pub fn recent_branches(&self) -> Result<Vec<RecentBranch>> {
        self.with(|s| s.repo.recent_branches(10).map_err(err))
    }

    pub fn local_changes(&self) -> Result<LocalChanges> {
        self.with(|s| s.repo.local_changes().map_err(err))
    }

    /// Changes the changelists and returns the new local changes.
    pub fn changelist_op(&self, op: ChangeListOp) -> Result<LocalChanges> {
        self.with(|s| {
            s.repo.changelist_op(op).map_err(err)?;
            s.repo.local_changes().map_err(err)
        })
    }

    pub fn push_info(&self, args: PushInfoArgs) -> Result<PushInfo> {
        self.with(|s| s.repo.push_info(args.branch.as_deref()).map_err(err))
    }

    pub fn stashes(&self) -> Result<Vec<Stash>> {
        self.with(|s| s.repo.stashes().map_err(err))
    }

    pub fn stash_detail(&self, args: IndexArgs) -> Result<StashDetail> {
        self.with(|s| s.repo.stash_detail(args.index).map_err(err))
    }

    pub fn merge_sides(&self, args: PathArgs) -> Result<MergeSides> {
        self.with(|s| s.repo.merge_sides(&args.path).map_err(err))
    }

    pub fn file_history(&self, args: PathArgs) -> Result<Vec<HistoryEntry>> {
        self.with(|s| s.repo.file_history(&args.path).map_err(err))
    }

    pub fn blame(&self, args: BlameArgs) -> Result<Blame> {
        self.with(|s| {
            let rev = match Self::rev(&s.repo, &args.rev)? {
                Rev::Commit(o) => Some(o),
                Rev::WorkTree => None,
                Rev::EmptyTree => return Err("The file does not exist in this revision".into()),
            };
            s.repo.blame(rev.as_deref(), &args.path).map_err(err)
        })
    }

    /// Counters that go up when the repository or its files change outside the app.
    pub fn watch_state(&self) -> Result<Option<watch::WatchCounters>> {
        self.with(|s| Ok(s.watcher.as_ref().map(|w| w.state.counters())))
    }

    /// The Local History versions of a file or a directory, or of all files when the path is empty.
    pub fn local_history(&self, args: PathArgs) -> Result<Vec<history::Revision>> {
        self.with(|s| Ok(s.history.revisions(Some(args.path.as_str()).filter(|p| !p.is_empty()), 2000)))
    }

    pub fn local_history_content(&self, args: BlobArgs) -> Result<history::Content> {
        self.with(|s| Ok(s.history.content(args.blob.as_deref())))
    }

    pub fn set_local_history_limits(&self, limits: history::Limits) -> Result<()> {
        *self.history_limits.lock().unwrap() = limits;
        for s in self.session.lock().unwrap().map.values() {
            s.history.set_limits(limits);
        }
        Ok(())
    }

    pub fn commit_template(&self) -> Result<Option<String>> {
        self.with(|s| Ok(s.repo.commit_template()))
    }

    pub fn remotes(&self) -> Result<Vec<rebased_git::remote::RemoteInfo>> {
        self.with(|s| s.repo.remote_details().map_err(err))
    }

    pub fn submodules(&self) -> Result<Vec<rebased_git::submodule::Submodule>> {
        self.with(|s| s.repo.submodules().map_err(err))
    }

    pub fn head_message(&self) -> Result<String> {
        self.with(|s| s.repo.head_message().map_err(err))
    }

    pub fn state(&self) -> Result<RepoState> {
        self.with(|s| s.repo.state().map_err(err))
    }

    pub fn rewrite_range(&self, args: OidArgs) -> Result<RewriteRange> {
        self.with(|s| s.repo.rewrite_range(&args.oid).map_err(err))
    }

    pub(crate) fn rev(repo: &Repo, spec: &RevSpec) -> Result<Rev> {
        match spec {
            RevSpec::Commit(o) => Ok(Rev::Commit(o.clone())),
            RevSpec::ParentOf(o) => repo.first_parent(o).map_err(err),
            RevSpec::Worktree => Ok(Rev::WorkTree),
        }
    }

    /// The commits that each of two refs has and the other has not.
    pub fn compare_refs(&self, args: CompareRefsArgs) -> Result<rebased_git::remote::RefComparison> {
        self.with(|s| s.repo.compare_refs(&args.left, &args.right).map_err(err))
    }

    pub fn compare(&self, args: CompareArgs) -> Result<CompareResult> {
        self.with(|s| {
            let (l, r) = (Self::rev(&s.repo, &args.left)?, Self::rev(&s.repo, &args.right)?);
            Ok(CompareResult { changes: s.repo.list_changes(&l, &r).map_err(err)? })
        })
    }

    pub fn file_pair(&self, args: FilePairArgs) -> Result<FilePair> {
        self.with(|s| {
            let (l, r) = (Self::rev(&s.repo, &args.left)?, Self::rev(&s.repo, &args.right)?);
            let left_path = args.old_path.as_deref().unwrap_or(&args.path);
            Ok(FilePair {
                left: s.repo.file_content(&l, left_path).map_err(err)?,
                right: s.repo.file_content(&r, &args.path).map_err(err)?,
            })
        })
    }
}
