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
        self.with_repo(|r| r.list_refs().map_err(err))
    }

    pub fn worktrees(&self) -> Result<Vec<Worktree>> {
        self.with_repo(|r| r.worktrees().map_err(err))
    }

    pub fn recent_branches(&self) -> Result<Vec<RecentBranch>> {
        self.with_repo(|r| r.recent_branches(10).map_err(err))
    }

    pub fn local_changes(&self) -> Result<LocalChanges> {
        self.with_repo(|r| r.local_changes().map_err(err))
    }

    /// Changes the changelists and returns the new local changes.
    pub fn changelist_op(&self, op: ChangeListOp) -> Result<LocalChanges> {
        self.with_repo(|r| {
            r.changelist_op(op).map_err(err)?;
            r.local_changes().map_err(err)
        })
    }

    pub fn push_info(&self, args: PushInfoArgs) -> Result<PushInfo> {
        self.with_repo(|r| r.push_info(args.branch.as_deref()).map_err(err))
    }

    pub fn stashes(&self) -> Result<Vec<Stash>> {
        self.with_repo(|r| r.stashes().map_err(err))
    }

    pub fn stash_detail(&self, args: IndexArgs) -> Result<StashDetail> {
        self.with_repo(|r| r.stash_detail(args.index).map_err(err))
    }

    pub fn merge_sides(&self, args: PathArgs) -> Result<MergeSides> {
        self.with_repo(|r| r.merge_sides(&args.path).map_err(err))
    }

    pub fn file_history(&self, args: PathArgs) -> Result<Vec<HistoryEntry>> {
        self.with_repo(|r| r.file_history(&args.path).map_err(err))
    }

    pub fn blame(&self, args: BlameArgs) -> Result<Blame> {
        self.with_repo(|r| {
            let rev = match Self::rev(r, &args.rev)? {
                Rev::Commit(o) => Some(o),
                Rev::WorkTree => None,
                Rev::EmptyTree => return Err("The file does not exist in this revision".into()),
            };
            r.blame(rev.as_deref(), &args.path).map_err(err)
        })
    }

    /// Counters that go up when the repository or its files change outside the app.
    pub fn watch_state(&self) -> Result<Option<watch::WatchCounters>> {
        self.with(|s| Ok(s.watcher.as_ref().map(|w| w.state.counters())))
    }

    /// The Local History versions of a file or a directory, or of all files when the path is empty.
    pub fn local_history(&self, args: PathArgs) -> Result<Vec<history::Revision>> {
        let h = self.with(|s| Ok(s.history.clone()))?;
        Ok(h.revisions(Some(args.path.as_str()).filter(|p| !p.is_empty()), 2000))
    }

    pub fn local_history_content(&self, args: BlobArgs) -> Result<history::Content> {
        let h = self.with(|s| Ok(s.history.clone()))?;
        Ok(h.content(args.blob.as_deref()))
    }

    /// The favorite branches and tags of the repository, as full ref names. None until the user chooses
    /// favorites. They are in the common git dir, so all worktrees share them.
    pub fn favorites(&self) -> Result<Option<Vec<String>>> {
        self.with_repo(|r| {
            let path = r.common_dir().join("rebased-lite").join("favorites.json");
            Ok(std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()))
        })
    }

    pub fn set_favorites(&self, refs: Vec<String>) -> Result<()> {
        self.with_repo(|r| {
            let dir = r.common_dir().join("rebased-lite");
            std::fs::create_dir_all(&dir).map_err(err)?;
            std::fs::write(dir.join("favorites.json"), serde_json::to_vec_pretty(&refs).map_err(err)?).map_err(err)
        })
    }

    pub fn commit_template(&self) -> Result<Option<String>> {
        self.with_repo(|r| Ok(r.commit_template()))
    }

    pub fn remotes(&self) -> Result<Vec<rebased_git::remote::RemoteInfo>> {
        self.with_repo(|r| r.remote_details().map_err(err))
    }

    pub fn submodules(&self) -> Result<Vec<rebased_git::submodule::Submodule>> {
        self.with_repo(|r| r.submodules().map_err(err))
    }

    pub fn head_message(&self) -> Result<String> {
        self.with_repo(|r| r.head_message().map_err(err))
    }

    pub fn state(&self) -> Result<RepoState> {
        self.with_repo(|r| r.state().map_err(err))
    }

    pub fn rewrite_range(&self, args: OidArgs) -> Result<RewriteRange> {
        self.with_repo(|r| r.rewrite_range(&args.oid).map_err(err))
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
        self.with_repo(|r| r.compare_refs(&args.left, &args.right).map_err(err))
    }

    pub fn compare(&self, args: CompareArgs) -> Result<CompareResult> {
        self.with_repo(|repo| {
            let (l, r) = (Self::rev(repo, &args.left)?, Self::rev(repo, &args.right)?);
            Ok(CompareResult { changes: repo.list_changes(&l, &r).map_err(err)? })
        })
    }

    pub fn file_pair(&self, args: FilePairArgs) -> Result<FilePair> {
        self.with_repo(|repo| {
            let (l, r) = (Self::rev(repo, &args.left)?, Self::rev(repo, &args.right)?);
            let left_path = args.old_path.as_deref().unwrap_or(&args.path);
            Ok(FilePair {
                left: repo.file_content(&l, left_path).map_err(err)?,
                right: repo.file_content(&r, &args.path).map_err(err)?,
            })
        })
    }
}
