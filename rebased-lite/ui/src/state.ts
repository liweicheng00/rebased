// The state that the modules share: the open repository, its refs, and the selection in the log.

import { type BranchInfo, type Change, type RecentBranch, type RepoState, type RevSpec, type Row, type UndoAction, type ViewResult, type Worktree } from "./api";

export const app = {
  view: null as ViewResult | null,
  refs: [] as BranchInfo[],
  recent: [] as RecentBranch[],
  worktrees: [] as Worktree[],
  repoState: null as RepoState | null,
  selected: [] as Row[],
  busy: 0,
  lastUndo: null as { actions: UndoAction[]; message: string } | null,
  diffSource: "log" as "log" | "local",
  left: "worktree" as RevSpec,
  rightRev: "worktree" as RevSpec,
  changeList: [] as Change[],
  active: -1,
  request: 0,
  watchQuietUntil: 0,
  watchSeen: null as { repo: number; files: number } | null,
};
