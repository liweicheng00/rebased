// Back and Forward between the files that the user looked at, as IntelliJ's Navigate > Back: in the
// diff below the log, in the local changes, and in the Compare, History, Review and Show Repository
// windows. The mouse buttons Back and Forward, and the keys of the keymap, move in this list.

import { closeWindows, showInWindow } from "./windows";

export interface Place {
  /** The same key is the same place: a second visit replaces the entry and adds no new one. */
  key: string;
  /** For the tooltip and the status bar. */
  label: string;
  /** Opens the place again. It can open a window and choose a file in it. */
  open: () => void | Promise<unknown>;
  /** The kind of window that holds the place; none for the main window. An open window of this kind
   * shows the place without a new window, when it can. */
  window?: string;
}

const MAX = 100;
const places: Place[] = [];
let at = -1;
/** True while Back or Forward opens a place: the visits of that opening do not count. */
let moving = false;

/** Records that the user looks at a place now. The places after the current one go. */
export function visit(p: Place) {
  if (moving) return;
  if (places[at]?.key === p.key) {
    places[at] = p;
    return;
  }
  places.splice(at + 1);
  places.push(p);
  if (places.length > MAX) places.shift();
  at = places.length - 1;
}

export const canGoBack = () => at > 0;
export const canGoForward = () => at < places.length - 1;

/** Goes to the place before. Returns its label, or null when there is none. */
export function back(): Promise<string | null> {
  return go(-1);
}

export function forward(): Promise<string | null> {
  return go(1);
}

/** The moves run one after the other, so quick clicks of Back all count. */
let queue: Promise<unknown> = Promise.resolve();

function go(step: number): Promise<string | null> {
  const run = queue.then(() => move(step));
  queue = run.catch(() => null);
  return run;
}

async function move(step: number): Promise<string | null> {
  const next = at + step;
  if (next < 0 || next >= places.length) return null;
  at = next;
  const p = places[at];
  moving = true;
  try {
    // The window of the place is still open: only its file changes, and nothing else draws again.
    if (p.window && showInWindow(p.window, p.key)) return p.label;
    closeWindows();
    await p.open();
    // A window chooses its file after it loads; those visits belong to this move too.
    await new Promise((r) => setTimeout(r, 400));
  } catch {
    // A place that is gone (for example a deleted branch) stays in the list; the next move skips past it.
  } finally {
    moving = false;
  }
  return p.label;
}

/** For tests: the keys of the list and the current index. */
export function navState() {
  return { keys: places.map((p) => p.key), at };
}
