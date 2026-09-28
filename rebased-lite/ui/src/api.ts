// Calls a backend command: through Tauri inside the app, or through the dev server in a browser.

export type RevSpec = { commit: string } | { parentOf: string } | "worktree";

export interface OpenResult {
  root: string;
  head: string | null;
  rowCount: number;
  recommendedWidth: number;
  loadMs: number;
}

/** One drawing element; see `El` in crates/service. */
export interface El {
  k: "n" | "e";
  p: number;
  o: number;
  d: "u" | "d";
  a: boolean;
  t: boolean;
  s: boolean;
  c: number;
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
  authorTime: number;
  elements: El[];
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

export interface CommitDetails {
  oid: string;
  subject: string;
  author: string;
  author_email: string;
  author_time: number;
  body: string;
}

const inTauri = "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args: unknown): Promise<T> {
  if (inTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, { args });
  }
  const res = await fetch(`/api/${cmd}`, { method: "POST", body: JSON.stringify(args) });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body as T;
}

export async function initialPath(): Promise<string | null> {
  if (!inTauri) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string | null>("initial_path");
}

export const api = {
  open: (path: string, intelliSort: boolean, showLongEdges: boolean) =>
    call<OpenResult>("open", { path, intelliSort, showLongEdges }),
  rows: (start: number, end: number) => call<Row[]>("rows", { start, end }),
  details: (oid: string) => call<CommitDetails>("details", { oid }),
  compare: (left: RevSpec, right: RevSpec) => call<{ changes: Change[] }>("compare", { left, right }),
  filePair: (left: RevSpec, right: RevSpec, path: string, oldPath: string | null) =>
    call<{ left: FileContent; right: FileContent }>("file_pair", { left, right, path, oldPath }),
};
