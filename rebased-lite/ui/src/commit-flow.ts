// The Changes tab: local changes, changelists, commit, rollback and partial changelists.

import { api, type ChangeListView } from "./api";
import { type LocalFile } from "./commit-panel";
import { menuBelow, type MenuItem, showMenu } from "./context-menu";
import { confirmDialog, formDialog } from "./dialogs";
import { toast } from "./notify";
import { currentBranch, runOp } from "./operations";
import { jumpToOid, loadLocalChanges } from "./repo";
import { save, settings } from "./settings";
import { commitPanel, diff } from "./shell";
import { app } from "./state";
import { WORKTREE } from "./compare-view";
import { compareBranches } from "./remotes";
import { pushBranch } from "./sync";

let localRequest = 0;
export async function showLocalDiff(f: LocalFile) {
  const req = ++localRequest;
  app.request++;
  app.diffSource = "local";
  const head = commitPanel.head;
  const status = f.change.status === "?" ? "A" : f.change.status === "U" ? "M" : f.change.status;
  const change = { ...f.change, status };
  diff.setSides(head ? "HEAD" : "empty", "working tree");
  try {
    const pair = head
      ? await api.filePair({ commit: head }, "worktree", change.path, change.old_path)
      : { left: { text: null, binary: false, size: 0, missing: true }, right: (await api.filePair("worktree", "worktree", change.path, null)).right };
    if (req !== localRequest || app.diffSource !== "local") return;
    if (f.change.status === "?") pair.left = { text: null, binary: false, size: 0, missing: true };
    diff.setSource(
      f.change.status === "D" ? (head ? { path: f.change.old_path ?? f.change.path, rev: { commit: head } } : null) : { path: f.change.path, rev: "worktree" },
    );
    // Changes of a modified file can go into the commit one by one.
    const text = !pair.left.missing && !pair.right.missing && !pair.left.binary && !pair.right.binary && !pair.left.note && !pair.right.note;
    // A file in more than one changelist commits by changelist, not by check boxes.
    const canSelect = f.list !== null && text && f.change.status !== "U" && !f.split;
    diff.setSelectable(canSelect ? { excluded: commitPanel.excludedFor(f.key), onChange: (ex, content) => commitPanel.setPartial(f.key, ex, content) } : null);
    const names = new Map(commitPanel.lists.map((l) => [l.id, l.name]));
    const hunks = f.split ? commitPanel.hunksOf(f.change.path) ?? [] : [];
    diff.setListHunks(hunks.filter((x) => x.list !== f.list).map((x) => ({ start: x.newStart, lines: x.newLines, label: names.get(x.list) ?? x.list })));
    diff.setMoveChange(f.list !== null && text && f.change.status === "M" ? (line, at) => moveChangeMenu(f, line, at) : null);
    diff.show(change, pair.left, pair.right);
  } catch (e) {
    if (req === localRequest) diff.message(String(e));
  }
}

function localPaths(files: LocalFile[]) {
  const paths: string[] = [];
  for (const f of files) {
    if (f.list === null) continue;
    paths.push(f.change.path);
    if (f.change.old_path) paths.push(f.change.old_path);
  }
  return paths;
}

export async function changeListOp(op: Parameters<typeof api.changeListOp>[0]) {
  try {
    commitPanel.set(await api.changeListOp(op));
  } catch (e) {
    toast(String(e).replace(/^Error: /, ""), "error");
  }
}

/** The menu of "Move Change to Another Changelist" in the diff of a local file. */
function moveChangeMenu(f: LocalFile, line: number, at: { x: number; y: number }) {
  const path = f.change.path;
  const hunk = commitPanel.hunksOf(path)?.find((x) => (x.newLines ? line >= x.newStart && line < x.newStart + x.newLines : line === x.newStart || line === x.newStart + 1));
  const current = hunk?.list ?? f.list;
  const move = async (to: string) => {
    await changeListOp({ op: "moveLines", path, lines: [line], to });
    commitPanel.revealFile(path, f.list);
  };
  const items: MenuItem[] = [{ header: "Move Change to Changelist" }];
  for (const l of commitPanel.lists) items.push({ label: l.name + (l.active ? " (active)" : ""), disabled: l.id === current, action: () => void move(l.id) });
  items.push({
    label: "New Changelist…",
    action: async () => {
      const before = new Set(commitPanel.lists.map((l) => l.id));
      await newChangeList();
      const created = commitPanel.lists.find((l) => !before.has(l.id));
      if (created) await move(created.id);
    },
  });
  showMenu(at.x, at.y, items);
}

export async function newChangeList(paths: string[] = []) {
  const r = await formDialog("New Changelist", [
    { key: "name", label: "Name", placeholder: "Feature work" },
    { key: "comment", label: "Comment (the draft commit message)", type: "textarea" },
    { key: "active", label: "Set active", type: "checkbox", value: paths.length === 0 },
  ], "Create", paths.length ? `${paths.length} file(s) move to the new changelist.` : "New changes go to the active changelist.");
  if (!r || !String(r.name).trim()) return;
  await changeListOp({ op: "create", name: String(r.name), comment: String(r.comment), makeActive: !!r.active, paths });
}

export async function editChangeList(l: ChangeListView) {
  const r = await formDialog(`Edit Changelist ${l.name}`, [
    { key: "name", label: "Name", value: l.name },
    { key: "comment", label: "Comment (the draft commit message)", type: "textarea", value: l.comment },
  ], "Save");
  if (!r || !String(r.name).trim()) return;
  await changeListOp({ op: "edit", id: l.id, name: String(r.name), comment: String(r.comment) });
}

export async function removeChangeList(l: ChangeListView) {
  if (commitPanel.lists.length === 1) return toast("The last changelist cannot be removed.", "error");
  const to = commitPanel.lists.find((x) => x.active && x.id !== l.id)?.name ?? commitPanel.lists.find((x) => x.id !== l.id)?.name;
  if (l.changes.length && !(await confirmDialog("Remove changelist", `Remove ${l.name}? Its ${l.changes.length} file(s) move to ${to}. The changes stay.`, "Remove"))) return;
  await changeListOp({ op: "remove", id: l.id });
}

export async function rollback(files: LocalFile[]) {
  const tracked = files.filter((f) => f.list !== null);
  if (!tracked.length) return;
  const added = tracked.filter((f) => f.change.status === "A").length;
  const text =
    `Roll back ${tracked.length} file(s) to the HEAD version? The local changes are lost.` +
    (added ? ` ${added} added file(s) are deleted from the disk.` : "");
  if (!(await confirmDialog("Rollback", text, "Rollback", true))) return;
  // A file in more than one changelist: only the changes of this changelist are rolled back.
  const whole = tracked.filter((f) => !f.split);
  for (const f of tracked.filter((x) => x.split)) {
    const ids = (commitPanel.hunksOf(f.change.path) ?? []).filter((x) => x.list === f.list).map((x) => x.id);
    await runOp({ op: "rollbackHunks", path: f.change.path, ids }, `Rolling back ${f.change.path}`);
  }
  if (whole.length) await runOp({ op: "rollback", paths: localPaths(whole) }, "Rolling back");
}

export async function deleteUnversioned(files: LocalFile[]) {
  const paths = files.filter((f) => f.list === null).map((f) => f.change.path);
  if (!paths.length) return;
  if (!(await confirmDialog("Delete files", `Delete ${paths.length} unversioned file(s) from the disk? This cannot be undone.`, "Delete", true))) return;
  await runOp({ op: "deleteUnversioned", paths }, "Deleting files");
}

/** Keeps a commit message in the history, newest first. */
function rememberMessage(message: string) {
  const m = message.trim();
  if (!m) return;
  settings.messageHistory = [m, ...settings.messageHistory.filter((x) => x !== m)].slice(0, 30);
  save();
}

commitPanel.onMessageHistory = (anchor) => {
  const items: MenuItem[] = settings.messageHistory.length
    ? settings.messageHistory.map((m) => {
        const first = m.split("\n")[0];
        return { label: first.length > 70 ? first.slice(0, 69) + "…" : first, action: () => commitPanel.setMessage(m) };
      })
    : [{ label: "No recent messages", disabled: true, action: () => {} }];
  menuBelow(anchor, [{ header: "Recent Commit Messages" }, ...items]);
};

async function commitFiles(files: LocalFile[], message: string, amend: boolean, list: string | null, push = false, signOff = false) {
  if (!message.trim()) {
    toast("Enter a commit message.", "error");
    commitPanel.focusMessage();
    return;
  }
  const warnings = commitPanel.messageWarnings;
  if (warnings.length && !(await confirmDialog("Commit message", `${warnings.join(" ")} Commit anyway?`, "Commit"))) return;
  const conflicts = files.filter((f) => f.change.status === "U");
  if (conflicts.length && !(await confirmDialog("Conflicts", `${conflicts.length} file(s) had conflicts. Commit them as they are in the working tree?`, "Commit"))) return;
  if (amend && app.view?.headOid) {
    const published = app.refs.some((b) => b.kind === "remote" && b.oid === app.view!.headOid);
    if (published && !(await confirmDialog("Commit is pushed", "The last commit is on a remote branch already. After amend you must force-push. Continue?", "Amend", true))) return;
  }
  const unversioned = files.filter((f) => f.list === null).map((f) => f.change.path);
  const partial: { path: string; content: string }[] = [];
  const whole: LocalFile[] = [];
  // A file in more than one changelist: the hunks of the checked changelists go in.
  const splitLists = new Map<string, Set<string>>();
  for (const f of files) {
    if (f.split && f.list !== null) {
      if (!splitLists.has(f.change.path)) splitLists.set(f.change.path, new Set());
      splitLists.get(f.change.path)!.add(f.list);
      continue;
    }
    const content = commitPanel.partialContent(f.key);
    if (content === null) whole.push(f);
    else partial.push({ path: f.change.path, content });
  }
  const hunks: { path: string; ids: string[] }[] = [];
  for (const [path, lists] of splitLists) {
    const all = commitPanel.hunksOf(path) ?? [];
    const ids = all.filter((x) => lists.has(x.list)).map((x) => x.id);
    if (ids.length === all.length) whole.push(files.find((f) => f.change.path === path)!);
    else hunks.push({ path, ids });
  }
  // A renamed file in part: the old path is removed whole.
  const paths = [...localPaths(whole), ...files.filter((f) => commitPanel.partialContent(f.key) !== null && f.change.old_path).map((f) => f.change.old_path!)];
  if ((partial.length || hunks.length) && app.repoState?.operation === "merge") return toast("A merge is in progress: commit whole files to finish it.", "error");
  const out = await runOp({ op: "commit", paths, unversioned, partial, hunks, message, amend, signOff }, amend ? "Amending" : "Committing");
  if (out?.result.ok) {
    rememberMessage(message);
    commitPanel.committed(list);
    if (list && !amend) await changeListOp({ op: "saveMessage", id: list, message: "" });
    if (out.head) void jumpToOid(out.head, true);
    if (push) await pushBranch();
  }
}

commitPanel.onOpen = (f) => void showLocalDiff(f);
commitPanel.onRefresh = () => void loadLocalChanges();
commitPanel.onRollback = (files) => void rollback(files);
commitPanel.onNewChangeList = () => void newChangeList();
commitPanel.onMove = (paths, to) => void changeListOp({ op: "move", paths, to });
commitPanel.onSaveMessage = (id, message) => void api.changeListOp({ op: "saveMessage", id, message }).catch(() => {});
commitPanel.onAmendToggle = () => api.headMessage().catch(() => "");
commitPanel.onCommit = (files, message, amend, list, push, signOff) => void commitFiles(files, message, amend, list, push, signOff);

// A double click on a local change opens the compare window: the current branch and the working tree,
// with this file first. The window lists all local changes, so the user can go through them there.
commitPanel.onActivate = (f) => compareBranches(currentBranch() ?? "HEAD", WORKTREE, f.change.path);
