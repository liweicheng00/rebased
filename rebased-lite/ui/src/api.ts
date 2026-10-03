// Calls a backend command: through Tauri inside the app, or through the dev server in a browser.

// The types of the command results come from the Rust types (ts-rs); see crates/*/src. The request
// types (RevSpec, LogFilter, ViewSettings, Op, ChangeListOp) stay here, because the front end builds them
// and many of their fields have defaults.
import type { Action } from "./bindings/Action";
import type { BackendSettings } from "./bindings/BackendSettings";
import type { Event as BackendEvent } from "./bindings/Event";
import type { ErrorKind } from "./bindings/ErrorKind";
import type { Blame } from "./bindings/Blame";
import type { BranchInfo } from "./bindings/BranchInfo";
import type { ChangeListView } from "./bindings/ChangeListView";
import type { CommitInfo } from "./bindings/CommitInfo";
import type { El } from "./bindings/El";
import type { FileContent } from "./bindings/FileContent";
import type { HistoryEntry } from "./bindings/HistoryEntry";
import type { Hunk } from "./bindings/Hunk";
import type { LocalChanges } from "./bindings/LocalChanges";
import type { MergeSides } from "./bindings/MergeSides";
import type { MergedBranches } from "./bindings/MergedBranches";
import type { FinishMode } from "./bindings/FinishMode";
import type { ReviewComment } from "./bindings/ReviewComment";
import type { ReviewDetail } from "./bindings/ReviewDetail";
import type { ReviewFile } from "./bindings/ReviewFile";
import type { ReviewSummary } from "./bindings/ReviewSummary";
import type { TagInfo } from "./bindings/TagInfo";
import type { OpOutcome } from "./bindings/OpOutcome";
import type { OpResult } from "./bindings/OpResult";
import type { OutgoingCommit } from "./bindings/OutgoingCommit";
import type { PlanEntry } from "./bindings/PlanEntry";
import type { Prompt } from "./bindings/Prompt";
import type { PushInfo } from "./bindings/PushInfo";
import type { RecentBranch } from "./bindings/RecentBranch";
import type { RefLabel } from "./bindings/RefLabel";
import type { RemoteInfo } from "./bindings/RemoteInfo";
import type { RepoState } from "./bindings/RepoState";
import type { Revision } from "./bindings/Revision";
import type { RewriteRange } from "./bindings/RewriteRange";
import type { Row } from "./bindings/Row";
import type { Stash } from "./bindings/Stash";
import type { StashDetail } from "./bindings/StashDetail";
import type { Submodule } from "./bindings/Submodule";
import type { UndoAction } from "./bindings/UndoAction";
import type { ViewResult } from "./bindings/ViewResult";
import type { Worktree } from "./bindings/Worktree";
import type { Change as ChangeResult } from "./bindings/Change";
export type {
  Action,
  BackendEvent,
  ErrorKind,
  BackendSettings,
  Blame,
  BranchInfo,
  ChangeListView,
  CommitInfo,
  El,
  FileContent,
  HistoryEntry,
  Hunk,
  LocalChanges,
  MergeSides,
  MergedBranches,
  FinishMode,
  ReviewComment,
  ReviewDetail,
  ReviewFile,
  ReviewSummary,
  TagInfo,
  OpOutcome,
  OpResult,
  OutgoingCommit,
  PlanEntry,
  Prompt,
  PushInfo,
  RecentBranch,
  RefLabel,
  RemoteInfo,
  RepoState,
  Revision,
  RewriteRange,
  Row,
  Stash,
  StashDetail,
  Submodule,
  UndoAction,
  ViewResult,
  Worktree,
};
export type LocalRevision = Revision;
export type AskpassPrompt = Prompt;
export type PlanAction = Action;
/** A changed file. `rightRev` is client side only: a right revision that differs from the compared one. */
export type Change = ChangeResult & { rightRev?: RevSpec };

export type RevSpec = { commit: string } | { parentOf: string } | "worktree";

export interface LogFilter {
  branches: string[];
  author: string;
  text: string;
  path: string;
  since: string;
}

export const inTauri = "__TAURI_INTERNALS__" in window;

/** The repository of the active tab. Each command names it, so an answer that arrives after a tab
 * switch still belongs to the tab that asked. */
let repoRoot: string | null = null;

export function setRepoRoot(root: string | null) {
  repoRoot = root;
}

async function call<T>(cmd: string, args?: unknown): Promise<T> {
  if (repoRoot && (args === undefined || (typeof args === "object" && args !== null && !Array.isArray(args)))) {
    args = { root: repoRoot, ...(args as object | undefined) };
  }
  // A command that does not answer leaves a part of the window empty; the warning names it.
  const slow = setTimeout(() => console.error(`The command ${cmd} has not answered after 10 s`), 10000);
  try {
    return await callNow<T>(cmd, args);
  } finally {
    clearTimeout(slow);
  }
}

/** A failed command, with the kind of the failure from the backend. */
export class ApiError extends Error {
  constructor(message: string, readonly kind: ErrorKind) {
    super(message);
  }
}

/** What the user can do after a failure of this kind, or "" when the message says enough. */
export function errorHint(kind: ErrorKind | undefined): string {
  switch (kind) {
    case "auth":
      return "Check the user name and the password or token, or the SSH key of this remote.";
    case "network":
      return "Check the network connection and the URL of the remote.";
    case "locked":
      return "Another git program uses the repository. When it has ended, delete the .lock file that the message names.";
    default:
      return "";
  }
}

async function callNow<T>(cmd: string, args?: unknown): Promise<T> {
  if (inTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    try {
      return await invoke<T>("call", { cmd, body: args ?? {} });
    } catch (e) {
      const f = e as { error?: string; kind?: ErrorKind };
      throw new ApiError(f.error ?? String(e), f.kind ?? "other");
    }
  }
  const res = await fetch(`/api/${cmd}`, { method: "POST", body: JSON.stringify(args ?? {}) });
  const body = await res.json();
  if (!res.ok) throw new ApiError(body.error ?? res.statusText, body.kind ?? "other");
  return body as T;
}

export interface ViewSettings {
  intelliSort: boolean;
  showLongEdges: boolean;
  collapseLinear: boolean;
  filter: LogFilter;
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
  | { op: "addRemote"; name: string; url: string }
  | { op: "removeRemote"; name: string }
  | { op: "renameRemote"; from: string; to: string }
  | { op: "setRemoteUrl"; name: string; url: string; pushUrl: string }
  | { op: "fetchRemote"; name: string }
  | { op: "pushTag"; remote: string; tag: string }
  | { op: "deleteRemoteRef"; remote: string; name: string }
  | { op: "setUpstream"; branch: string; upstream: string | null }
  | { op: "deleteMerged"; upstreams: string[]; keep: string[]; expected: string[] }
  | { op: "deleteMergedInto"; target: string; names: string[] }
  | { op: "pushAllTags"; remote: string }
  | { op: "finishReview"; branch: string; mode: FinishMode; message: string; deleteBranch: boolean }
  | { op: "rollbackHunks"; path: string; ids: string[] }
  | { op: "revertLocalHistory"; path: string; blob: string | null }
  | { op: "addWorktree"; path: string; branch: string; newBranch: boolean; at: string }
  | { op: "removeWorktree"; path: string; force: boolean }
  | { op: "pruneWorktrees" }
  | { op: "commit"; paths: string[]; unversioned: string[]; partial?: { path: string; content: string }[]; hunks?: { path: string; ids: string[] }[]; message: string; amend: boolean; signOff?: boolean }
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

export type ChangeListOp =
  | { op: "create"; name: string; comment?: string; makeActive?: boolean; paths?: string[] }
  | { op: "edit"; id: string; name: string; comment: string }
  | { op: "remove"; id: string }
  | { op: "setActive"; id: string }
  | { op: "move"; paths: string[]; to: string }
  | { op: "moveLines"; path: string; lines: number[]; to: string }
  | { op: "saveMessage"; id: string; message: string };

export const api = {
  open: (path: string, view: ViewSettings) => call<ViewResult>("open", { path, ...view }),
  /** Makes an open repository active, for a tab switch; opens it when it is not open. */
  activate: (path: string, view: ViewSettings) => call<ViewResult>("activate", { path, ...view }),
  close: (path: string) => call<null>("close", { path }),
  /** The version of a git program; it changes nothing. Empty means git from PATH. */
  gitVersion: (path: string) => call<string>("git_version", { path }),
  backendSettings: () => call<BackendSettings>("backend_settings"),
  /** Applies and saves the settings of the backend; returns the version of the git program. */
  setBackendSettings: (s: BackendSettings) => call<string>("set_backend_settings", s),
  favorites: () => call<string[] | null>("favorites"),
  setFavorites: (refs: string[]) => call<null>("set_favorites", { refs }),
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
  askpassAnswer: (id: number, answer: string | null, remember: boolean) => call<null>("askpass_answer", { id, answer, remember }),
  watchState: () => call<{ repo: number; files: number } | null>("watch_state"),
  stashes: () => call<Stash[]>("stashes"),
  localHistory: (path: string) => call<LocalRevision[]>("local_history", { path }),
  localHistoryContent: (blob: string | null) => call<Omit<FileContent, "size">>("local_history_content", { blob }),
  submodules: () => call<Submodule[]>("submodules"),
  remotes: () => call<RemoteInfo[]>("remotes"),
  commitTemplate: () => call<string | null>("commit_template"),
  fileHistory: (path: string) => call<HistoryEntry[]>("file_history", { path }),
  blame: (path: string, rev: RevSpec) => call<Blame>("blame", { path, rev }),
  mergeSides: (path: string) => call<MergeSides>("merge_sides", { path }),
  stashDetail: (index: number) => call<StashDetail>("stash_detail", { index }),
  pushInfo: (branch?: string) => call<PushInfo>("push_info", { branch: branch ?? null }),
  reviews: () => call<ReviewSummary[]>("reviews"),
  review: (branch: string) => call<ReviewDetail>("review", { branch }),
  reviewEdit: (edit: ReviewEdit) => call<null>("review_edit", edit),
  /** Opens a web page: the default browser in the app, a new tab in a browser. */
  openUrl: (url: string) => (inTauri ? call<null>("open_url", { url }) : Promise.resolve(void window.open(url, "_blank", "noopener")).then(() => null)),
  tagInfo: (name: string) => call<TagInfo>("tag_info", { name }),
  remoteTags: (remote: string) => call<string[]>("remote_tags", { remote }),
  mergedInto: (target: string) => call<MergedBranches>("merged_into", { target }),
  mergedBranches: (upstreams: string[]) => call<MergedBranches>("merged_branches", { upstreams }),
  compareRefs: (left: string, right: string) =>
    call<{ left: string; right: string; base: string | null; onlyLeft: OutgoingCommit[]; onlyRight: OutgoingCommit[] }>("compare_refs", { left, right }),
  compare: (left: RevSpec, right: RevSpec) => call<{ changes: Change[] }>("compare", { left, right }),
  filePair: (left: RevSpec, right: RevSpec, path: string, oldPath: string | null) =>
    call<{ left: FileContent; right: FileContent }>("file_pair", { left, right, path, oldPath }),
};

/** Calls `handler` for each event of the backend: in the app a window event, in a browser a server-sent
 * event. EventSource connects again by itself after the dev server restarts. */
export async function onBackendEvent(handler: (e: BackendEvent) => void) {
  if (inTauri) {
    const { listen } = await import("@tauri-apps/api/event");
    await listen<BackendEvent>("backend-event", (e) => handler(e.payload));
    return;
  }
  const source = new EventSource("/events");
  source.onmessage = (m) => handler(JSON.parse(m.data) as BackendEvent);
}

export async function initialPath(): Promise<string | null> {
  if (!inTauri) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string | null>("initial_path");
}

/** Asks for a folder with the native dialog. Returns null in a browser, where the caller shows a text field. */
/** Asks for a file with the native dialog. Returns null in a browser. */
export async function pickFile(title: string): Promise<string | null> {
  if (inTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const r = await open({ directory: false, multiple: false, title });
    return typeof r === "string" ? r : null;
  }
  return null;
}

export async function pickFolder(title = "Open Git Repository"): Promise<string | null> {
  if (inTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const r = await open({ directory: true, multiple: false, title });
    return typeof r === "string" ? r : null;
  }
  return null;
}

/** A change to the review data. */
export type ReviewEdit =
  | { action: "start"; branch: string; base: string }
  | { action: "remove"; branch: string }
  | { action: "viewed"; branch: string; paths: string[]; viewed: boolean }
  | { action: "comment"; branch: string; path: string; line: number; text: string }
  | { action: "deleteComment"; branch: string; id: string };
