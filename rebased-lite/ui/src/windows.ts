// The open windows (Compare, Review, History, Show Repository at Revision). Back and Forward close them
// before they open a place in another window, and they keep the window that can show the place.

interface OpenWindow {
  close: () => void;
  /** The kind of the window, as the places name it: "compare", "history", "review" or "tree". */
  kind?: string;
  /** Shows the place of a key in this window, without a new window. False when it cannot. */
  show?: (key: string) => boolean;
}

const windows = new Set<OpenWindow>();

/** Registers an open window. The returned function takes it out again; call it when the window closes. */
export function registerWindow(close: () => void, kind?: string, show?: (key: string) => boolean): () => void {
  const w: OpenWindow = { close, kind, show };
  windows.add(w);
  return () => windows.delete(w);
}

/** Shows a place in an open window of its kind. Then the other windows close. False when no open window
 * can show it. */
export function showInWindow(kind: string, key: string): boolean {
  for (const w of windows) {
    if (w.kind === kind && w.show?.(key)) {
      for (const other of [...windows]) if (other !== w) other.close();
      return true;
    }
  }
  return false;
}

/** Closes all open windows. */
export function closeWindows() {
  for (const w of [...windows]) w.close();
}

/** What changed outside the app: files of the working tree, or refs and commits of the repository. */
export type RepoChange = "files" | "repo";

const listeners = new Set<(change: RepoChange) => void>();

/** Calls `fn` when the watcher sees a change outside the app. The returned function stops it. */
export function onRepoChange(fn: (change: RepoChange) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Tells the open windows that files or refs changed. */
export function notifyRepoChange(change: RepoChange) {
  for (const fn of [...listeners]) fn(change);
}
