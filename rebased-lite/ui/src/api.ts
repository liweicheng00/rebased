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
}

export interface FileContent {
  text: string | null;
  binary: boolean;
  size: number;
  missing: boolean;
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
  filter: LogFilter;
}

export const api = {
  open: (path: string, view: ViewSettings) => call<ViewResult>("open", { path, ...view }),
  setView: (view: ViewSettings) => call<ViewResult>("set_view", view),
  refresh: () => call<ViewResult>("refresh"),
  fetch: () => call<ViewResult>("fetch"),
  refs: () => call<BranchInfo[]>("refs"),
  rows: (start: number, end: number) => call<Row[]>("rows", { start, end }),
  commit: (oid: string) => call<CommitInfo>("commit", { oid }),
  find: (query: string) => call<{ oid: string | null; row: number | null }>("find", { query }),
  compare: (left: RevSpec, right: RevSpec) => call<{ changes: Change[] }>("compare", { left, right }),
  filePair: (left: RevSpec, right: RevSpec, path: string, oldPath: string | null) =>
    call<{ left: FileContent; right: FileContent }>("file_pair", { left, right, path, oldPath }),
};

export async function initialPath(): Promise<string | null> {
  if (!inTauri) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string | null>("initial_path");
}

/** Asks for a repository folder: a native dialog in the app, a text prompt in a browser. */
export async function pickFolder(): Promise<string | null> {
  if (inTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const r = await open({ directory: true, multiple: false, title: "Open Git Repository" });
    return typeof r === "string" ? r : null;
  }
  return null;
}
