// Calls a backend command: through Tauri inside the app, or through the dev server in a browser.

export type RevSpec = { commit: string } | { parentOf: string } | "worktree";

export interface LogFilter {
  branches: string[];
  author: string;
  text: string;
  path: string;
  since: string;
}

export interface ViewResult {
  root: string;
  head: string | null;
  headOid: string | null;
  totalCommits: number;
  rowCount: number;
  filtered: boolean;
  collapsed: boolean;
  recommendedWidth: number;
  loadMs: number;
}

/** One drawing element; see `El` in crates/service. `j` is the row an arrow jumps to. */
export interface El {
  k: "n" | "e";
  p: number;
  o: number;
  d: "u" | "d";
  a: boolean;
  t: boolean;
  s: boolean;
  c: number;
  j?: number;
  /** Rows [upper, lower] of a collapsed branch; clicking the edge expands it. */
  x?: [number, number];
}

export interface RefLabel {
  name: string;
  kind: "head" | "local" | "remote" | "tag" | "other";
}

export interface Row {
  row: number;
  oid: string;
  refs: RefLabel[];
  subject: string;
  author: string;
  authorEmail: string;
  authorTime: number;
  isHead: boolean;
  elements: El[];
}

export interface BranchInfo {
  name: string;
  full: string;
  kind: "local" | "remote" | "tag";
  oid: string;
  current: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  subject: string;
}

export interface Change {
  status: string;
  path: string;
  old_path: string | null;
  /** Client side only: a right revision for this file that differs from the compared revision. */
  rightRev?: RevSpec;
}

/** A version of a file in Local History. */
export interface LocalRevision {
  time: number;
  path: string;
  /** Null when the file did not exist at this time. */
  blob: string | null;
  /** Why the version was made, for example "Before Rollback". Empty for a change on disk. */
  label: string;
}

export interface FileContent {
  text: string | null;
  binary: boolean;
  size: number;
  missing: boolean;
  /** Why the content is special, for example a submodule or a Git LFS object that is not downloaded. */
  note?: string;
}

export interface Submodule {
  path: string;
  /** The commit that the repository records. */
  recorded: string;
  /** The checked-out commit. Null when the submodule is not initialized. */
  current: string | null;
  state: "uninitialized" | "clean" | "otherCommit" | "conflict";
  dirty: boolean;
  url: string | null;
}

export interface CommitInfo {
  oid: string;
  parents: string[];
  subject: string;
  body: string;
  author: string;
  author_email: string;
  author_time: number;
  committer: string;
  committer_email: string;
  commit_time: number;
  refs: RefLabel[];
}

export const inTauri = "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: unknown): Promise<T> {
  // A command that does not answer leaves a part of the window empty; the warning names it.
  const slow = setTimeout(() => console.warn(`The command ${cmd} has not answered after 10 s`), 10000);
  try {
    return await callNow<T>(cmd, args);
  } finally {
    clearTimeout(slow);
  }
}

async function callNow<T>(cmd: string, args?: unknown): Promise<T> {
  if (inTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args === undefined ? {} : { args });
  }
  const res = await fetch(`/api/${cmd}`, { method: "POST", body: JSON.stringify(args ?? {}) });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body as T;
}

export interface ViewSettings {
  intelliSort: boolean;
  showLongEdges: boolean;
  collapseLinear: boolean;
  filter: LogFilter;
}

export interface RepoState {
  operation: "none" | "merge" | "rebase" | "cherry-pick" | "revert";
  branch: string | null;
  head: string | null;
  conflicts: string[];
  changedFiles: number;
  /** The commit where an interactive rebase stopped for editing. */
  editing: string | null;
  /** The branch that a rebase in progress rewrites. */
  rebasing: string | null;
}

export interface OpResult {
  ok: boolean;
  message: string;
  conflicts: string[];
  /** The steps that undo the operation. Empty when it cannot be undone. */
  undo: UndoAction[];
}

export type UndoAction =
  | { kind: "reset"; to: string; expectedHead: string; mode: "keep" | "soft" | "mixed" }
  | { kind: "checkout"; target: string; detach: boolean; expectedHead: string }
  | { kind: "createRef"; name: string; oid: string }
  | { kind: "deleteRef"; name: string; expected: string }
  | { kind: "renameBranch"; from: string; to: string }
  | { kind: "stashStore"; oid: string; message: string };

export interface OpOutcome {
  result: OpResult;
  view: ViewResult;
  head: string | null;
  /** Submodules that are not at the recorded commit after the operation moved HEAD. */
  staleSubmodules: string[];
}

export type PlanAction = "pick" | "reword" | "edit" | "squash" | "fixup" | "drop";

export interface PlanEntry {
  oid: string;
  action: PlanAction;
  message?: string;
}

export interface RewriteRange {
  base: string;
  entries: { oid: string; subject: string; message: string; author: string }[];
  published: boolean;
}

export interface Worktree {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
  current: boolean;
  main: boolean;
}

export interface RecentBranch {
  name: string;
  oid: string;
  subject: string;
  time: number;
}

export type Op =
  | { op: "checkout"; target: string; kind: "local" | "remote" | "commit" }
  | { op: "createBranch"; name: string; at: string; checkout: boolean }
  | { op: "createTag"; name: string; at: string; message: string }
  | { op: "renameBranch"; from: string; to: string }
  | { op: "deleteBranch"; name: string; force: boolean }
  | { op: "deleteTag"; name: string }
  | { op: "merge"; rev: string }
  | { op: "rebase"; onto: string }
  | { op: "cherryPick"; oids: string[] }
  | { op: "revert"; oids: string[] }
  | { op: "reset"; to: string; mode: "soft" | "mixed" | "hard" | "keep" }
  | { op: "continue" }
  | { op: "abort" }
  | { op: "markResolved"; paths: string[] }
  | { op: "rewrite"; base: string; plan: PlanEntry[]; what: string }
  | { op: "undo"; actions: UndoAction[] }
  | { op: "updateSubmodules"; paths: string[] }
  | { op: "revertLocalHistory"; path: string; blob: string | null }
  | { op: "addWorktree"; path: string; branch: string; newBranch: boolean; at: string }
  | { op: "removeWorktree"; path: string; force: boolean }
  | { op: "pruneWorktrees" }
  | { op: "commit"; paths: string[]; unversioned: string[]; partial?: { path: string; content: string }[]; message: string; amend: boolean }
  | { op: "rollback"; paths: string[] }
  | { op: "addFiles"; paths: string[] }
  | { op: "deleteUnversioned"; paths: string[] }
  | { op: "push"; branch: string; remote: string; remoteBranch: string; force: boolean; setUpstream: boolean; tags: boolean }
  | { op: "update"; mode: "merge" | "rebase" }
  | { op: "stashPush"; message: string; paths: string[]; includeUntracked: boolean; keepIndex: boolean }
  | { op: "stashApply"; index: number; pop: boolean; restoreIndex: boolean }
  | { op: "stashDrop"; index: number }
  | { op: "stashBranch"; index: number; branch: string }
  | { op: "resolveText"; path: string; text: string }
  | { op: "resolveSide"; paths: string[]; side: "ours" | "theirs" }
  | { op: "applyFileChanges"; from: string; to: string; paths: string[]; reverse: boolean }
  | { op: "getFromRevision"; rev: string; paths: string[] };

export interface AskpassPrompt {
  id: number;
  text: string;
  secret: boolean;
  confirm: boolean;
}

export interface HistoryEntry {
  oid: string;
  parents: string[];
  subject: string;
  author: string;
  time: number;
  status: string;
  path: string;
  oldPath: string | null;
}

export interface Blame {
  commits: { oid: string; author: string; time: number; summary: string; uncommitted: boolean }[];
  lines: number[];
}

export interface MergeSides {
  path: string;
  base: { text: string | null; label: string };
  ours: { text: string | null; label: string };
  theirs: { text: string | null; label: string };
  binary: boolean;
}

export interface Stash {
  index: number;
  oid: string;
  message: string;
  branch: string | null;
  time: number;
}

export interface StashDetail {
  oid: string;
  base: string;
  untrackedOid: string | null;
  changes: Change[];
  untracked: string[];
}

export interface OutgoingCommit {
  oid: string;
  subject: string;
  author: string;
  time: number;
}

export interface PushInfo {
  branch: string;
  remotes: string[];
  remote: string | null;
  remoteBranch: string;
  upstream: string | null;
  newBranch: boolean;
  outgoing: OutgoingCommit[];
  behind: number;
}

export interface ChangeListView {
  id: string;
  name: string;
  comment: string;
  active: boolean;
  changes: Change[];
}

export interface LocalChanges {
  lists: ChangeListView[];
  unversioned: string[];
  conflicts: string[];
  head: string | null;
}

export type ChangeListOp =
  | { op: "create"; name: string; comment?: string; makeActive?: boolean; paths?: string[] }
  | { op: "edit"; id: string; name: string; comment: string }
  | { op: "remove"; id: string }
  | { op: "setActive"; id: string }
  | { op: "move"; paths: string[]; to: string }
  | { op: "saveMessage"; id: string; message: string };

export const api = {
  open: (path: string, view: ViewSettings) => call<ViewResult>("open", { path, ...view }),
  setView: (view: ViewSettings) => call<ViewResult>("set_view", view),
  refresh: () => call<ViewResult>("refresh"),
  fetch: () => call<ViewResult>("fetch"),
  refs: () => call<BranchInfo[]>("refs"),
  rows: (start: number, end: number) => call<Row[]>("rows", { start, end }),
  commit: (oid: string) => call<CommitInfo>("commit", { oid }),
  find: (query: string) => call<{ oid: string | null; row: number | null; rowCount: number | null }>("find", { query }),
  collapse: (mode: "all" | "none" | "row" | "edge", row?: number, up?: number, down?: number) =>
    call<ViewResult>("collapse", { mode, row, up, down }),
  repoState: () => call<RepoState>("repo_state"),
  rewriteRange: (base: string) => call<RewriteRange>("rewrite_range", { oid: base }),
  runOp: (op: Op) => call<OpOutcome>("run_op", op),
  worktrees: () => call<Worktree[]>("worktrees"),
  recentBranches: () => call<RecentBranch[]>("recent_branches"),
  localChanges: () => call<LocalChanges>("local_changes"),
  changeListOp: (op: ChangeListOp) => call<LocalChanges>("changelist_op", op),
  headMessage: () => call<string>("head_message"),
  askpassPending: () => call<AskpassPrompt[]>("askpass_pending"),
  askpassAnswer: (id: number, answer: string | null, remember: boolean) => call<null>("askpass_answer", { id, answer, remember }),
  watchState: () => call<{ repo: number; files: number } | null>("watch_state"),
  stashes: () => call<Stash[]>("stashes"),
  localHistory: (path: string) => call<LocalRevision[]>("local_history", { path }),
  localHistoryContent: (blob: string | null) => call<Omit<FileContent, "size">>("local_history_content", { blob }),
  setLocalHistoryLimits: (days: number, maxMb: number) => call<null>("set_local_history_limits", { days, maxMb }),
  submodules: () => call<Submodule[]>("submodules"),
  fileHistory: (path: string) => call<HistoryEntry[]>("file_history", { path }),
  blame: (path: string, rev: RevSpec) => call<Blame>("blame", { path, rev }),
  mergeSides: (path: string) => call<MergeSides>("merge_sides", { path }),
  stashDetail: (index: number) => call<StashDetail>("stash_detail", { index }),
  pushInfo: (branch?: string) => call<PushInfo>("push_info", { branch: branch ?? null }),
  compare: (left: RevSpec, right: RevSpec) => call<{ changes: Change[] }>("compare", { left, right }),
  filePair: (left: RevSpec, right: RevSpec, path: string, oldPath: string | null) =>
    call<{ left: FileContent; right: FileContent }>("file_pair", { left, right, path, oldPath }),
};

export async function initialPath(): Promise<string | null> {
  if (!inTauri) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string | null>("initial_path");
}

/** Asks for a folder with the native dialog. Returns null in a browser, where the caller shows a text field. */
export async function pickFolder(title = "Open Git Repository"): Promise<string | null> {
  if (inTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const r = await open({ directory: true, multiple: false, title });
    return typeof r === "string" ? r : null;
  }
  return null;
}
