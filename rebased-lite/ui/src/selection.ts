// The commits selected in the log, their changed files, the diff, and collapsed branches.

import { api, type Change, type RevSpec, type Row } from "./api";
import { confirmDialog } from "./dialogs";
import { runOp } from "./operations";
import { jumpToOid } from "./repo";
import { save, settings } from "./settings";
import { changes, commitPanel, details, diff, log, stashPanel, task, updateStatus } from "./shell";
import { app } from "./state";

/** Which panel the diff shows a file of: the changes of the selected commits, or the local changes. */

export function clearCompare() {
  app.request++;
  app.changeList = [];
  changes.setTitle("Changes");
  changes.setMessage("Select a commit to see its changes.");
  details.clear();
  diff.message("Select a commit to see its changes.");
}

export function short(oid: string) {
  return oid.slice(0, 8);
}

export async function compare(l: RevSpec, r: RevSpec, title: string, leftLabel: string, rightLabel: string) {
  const req = ++app.request;
  app.left = l;
  app.rightRev = r;
  app.active = -1;
  changes.setTitle(title);
  changes.setMessage("Loading…");
  diff.message("Loading…");
  diff.setSides(leftLabel, rightLabel);
  try {
    const res = await api.compare(l, r);
    if (req !== app.request) return;
    app.changeList = res.changes;
    changes.setChanges(app.changeList);
    if (app.changeList.length) void openFile(changes.firstInOrder());
    else diff.message("There are no changes.");
  } catch (e) {
    if (req === app.request) {
      changes.setMessage(String(e));
      diff.message("");
    }
  }
}

export async function openFile(i: number) {
  if (i < 0 || i >= app.changeList.length) return;
  const req = app.request;
  app.active = i;
  changes.setActive(i);
  const c = app.changeList[i];
  try {
    const r = c.rightRev ?? app.rightRev;
    const pair = await api.filePair(app.left, r, c.path, c.old_path);
    if (req !== app.request || app.active !== i) return;
    diff.setSource(c.status === "D" ? { path: c.old_path ?? c.path, rev: app.left } : { path: c.path, rev: r });
    diff.setSelectable(null);
    diff.setListHunks([]);
    diff.setMoveChange(null);
    diff.show(c, pair.left, pair.right);
  } catch (e) {
    if (req === app.request) diff.message(String(e));
  }
}

export function showSelection(rows: Row[]) {
  app.selected = rows;
  stashPanel.clearSelection();
  app.diffSource = "log";
  commitPanel.setActiveFile(null);
  void details.show(rows);
  if (rows.length === 0) return clearCompare();
  if (rows.length === 1) {
    const r = rows[0];
    return void compare({ parentOf: r.oid }, { commit: r.oid }, `Changes in ${short(r.oid)}`, "parent", short(r.oid));
  }
  // Rows are sorted top to bottom: the last row is the oldest, as in IntelliJ.
  const newer = rows[0];
  const older = rows[rows.length - 1];
  const title = rows.length === 2 ? `${short(older.oid)} → ${short(newer.oid)}` : `${short(older.oid)} → ${short(newer.oid)} (oldest and newest of ${rows.length})`;
  void compare({ commit: older.oid }, { commit: newer.oid }, title, short(older.oid), short(newer.oid));
}

export function compareWithWorktree(r: Row) {
  void compare({ commit: r.oid }, "worktree", `${short(r.oid)} → working tree`, short(r.oid), "working tree");
}

log.onSelectionChange = showSelection;
changes.onOpen = (i) => void openFile(i);
changes.onSwap = () => {
  if (app.rightRev === "worktree" || app.left === "worktree") return;
  const [l, r] = [app.left, app.rightRev];
  const label = (s: RevSpec) => (typeof s === "object" && "commit" in s ? short(s.commit) : "parent");
  void compare(r, l, `${label(r)} → ${label(l)}`, label(r), label(l));
};
diff.onNextFile = () => (app.diffSource === "local" ? commitPanel.move(1) : changes.move(1));
diff.onPrevFile = () => (app.diffSource === "local" ? commitPanel.move(-1) : changes.move(-1));
details.onJump = (oid) => void jumpToOid(oid, true);

export async function collapse(mode: "all" | "none" | "row" | "edge", row?: number, up?: number, down?: number) {
  const keep = app.selected.map((s) => s.oid);
  const r = await task(mode === "all" ? "Collapsing linear branches" : "Updating the graph", () => api.collapse(mode, row, up, down));
  if (!r) return;
  if (mode === "all" || mode === "none") {
    settings.collapseLinear = mode === "all";
    save();
  }
  app.view = r;
  log.setCollapsed(r.collapsed);
  log.reset(r.rowCount, r.recommendedWidth, true);
  updateStatus();
  if (keep.length) {
    const rows = (await Promise.all(keep.map((o) => api.find(o)))).map((f) => f.row).filter((x): x is number => x !== null);
    if (rows.length) log.select(rows);
  }
}
log.onCollapseAll = () => void collapse("all");
log.onExpandAll = () => void collapse("none");
log.onExpandEdge = (up, down) => void collapse("edge", undefined, up, down);

/** The commits of the current comparison, when both sides are commits. */
export function comparedCommits(): { from: string; to: string } | null {
  const from = typeof app.left === "object" ? ("commit" in app.left ? app.left.commit : `${app.left.parentOf}^`) : null;
  const to = typeof app.rightRev === "object" && "commit" in app.rightRev ? app.rightRev.commit : null;
  return from && to ? { from, to } : null;
}

export async function fileChangesAction(files: Change[], kind: "revert" | "pick" | "get") {
  const pair = comparedCommits();
  if (!pair) return;
  const paths = files.flatMap((c) => (c.old_path ? [c.path, c.old_path] : [c.path]));
  const n = files.length;
  if (kind === "get") {
    const what = short(pair.to);
    if (!(await confirmDialog("Get from Revision", `Replace ${n} file(s) in the working tree with their version in ${what}? Local changes to them are lost.`, "Get", true))) return;
    await runOp({ op: "getFromRevision", rev: pair.to, paths }, "Getting files");
  } else {
    await runOp({ op: "applyFileChanges", from: pair.from, to: pair.to, paths, reverse: kind === "revert" }, kind === "revert" ? "Reverting changes" : "Applying changes");
  }
}
