// Push and Update, and the context menu of local files.

import { openInEditor } from "./editor-flow";
import { keymap } from "./keyboard";
import { api } from "./api";
import { changeListOp, deleteUnversioned, editChangeList, newChangeList, removeChangeList, rollback, showLocalDiff } from "./commit-flow";
import { mergeFile } from "./conflicts";
import { type MenuItem, showMenu } from "./context-menu";
import { confirmDialog, pushDialog, updateDialog } from "./dialogs";
import { copyText } from "./dom";
import { showHistory, showLocalHistory } from "./history-flow";
import { toast } from "./notify";
import { currentBranch, runOp } from "./operations";
import { save, settings } from "./settings";
import { globalPatterns } from "./ignore-patterns";
import { isProtected } from "./protected";
import { openSettings } from "./settings-flow";
import { commitPanel, diff, mod, pushBtn, updateBtn } from "./shell";
import { stashChanges } from "./stash-flow";
import { app } from "./state";

/** Pushes a branch; with `upTo`, only its commits up to that commit (Push All up to Here). */
export async function pushBranch(branch?: string, upTo?: string) {
  let info;
  try {
    info = await api.pushInfo(branch);
  } catch (e) {
    return toast(String(e).replace(/^Error: /, ""), "error");
  }
  if (!info.remote) return toast("The repository has no remote.", "error");
  if (upTo) {
    // The outgoing commits are newest first: the push takes the commit and the older ones.
    const at = info.outgoing.findIndex((c) => c.oid === upTo);
    if (at < 0) return toast(`${upTo.slice(0, 8)} is not an outgoing commit of ${info.branch}: the remote has it already.`, "info");
    info = { ...info, outgoing: info.outgoing.slice(at) };
  }
  if (!info.outgoing.length && !info.newBranch) return toast(`Nothing to push: ${info.branch} is up to date with ${info.upstream}.`, "info");
  const choice = await pushDialog(info, upTo?.slice(0, 8));
  if (!choice) return;
  if (choice.force && isProtected(choice.remoteBranch)) {
    return toast(`${choice.remote}/${choice.remoteBranch} is a protected branch: Rebased Lite does not force push to it. Settings › Git › Protected branches.`, "error");
  }
  if (choice.force && !(await confirmDialog("Force push", `Force push ${info.branch} to ${choice.remote}/${choice.remoteBranch}? Commits on the remote branch that are not in ${info.branch} are removed from it.`, "Force Push", true))) return;
  const branchName = info.branch;
  const retry =
    branchName === currentBranch() ? { label: "Update", run: () => void updateBranch().then((ok) => ok && void pushBranch(branchName)) } : undefined;
  await runOp({ op: "push", branch: branchName, ...choice, ...(upTo ? { rev: upTo } : {}) }, `Pushing ${branchName}`, retry);
}

/** Returns true when the update finished without a conflict. */
export async function updateBranch(): Promise<boolean> {
  const branch = currentBranch();
  if (!branch) {
    toast("HEAD is detached. Checkout a branch first.", "error");
    return false;
  }
  const upstream = app.refs.find((b) => b.kind === "local" && b.name === branch)?.upstream ?? null;
  if (!upstream) {
    toast(`${branch} has no tracked branch. Push it with a tracked branch first.`, "error");
    return false;
  }
  const choice = await updateDialog(branch, upstream, settings.updateMode, settings.updateFf);
  if (!choice) return false;
  const { mode, ff } = choice;
  settings.updateMode = mode;
  if (mode === "merge") settings.updateFf = ff;
  save();
  const out = await runOp({ op: "update", mode, options: { ffOnly: ff === "ffOnly", noFf: ff === "noFf" } }, `Updating ${branch}`);
  return !!out?.result.ok;
}

pushBtn.addEventListener("click", () => void pushBranch());
updateBtn.addEventListener("click", () => void updateBranch());
commitPanel.onFileMenu = (files, e) => {
  const tracked = files.filter((f) => f.list !== null);
  const untracked = files.filter((f) => f.list === null);
  const conflicted = files.filter((f) => f.change.status === "U");
  const items: MenuItem[] = [
    ...(conflicted.length
      ? [
          { label: "Resolve Conflict…", disabled: conflicted.length !== 1, action: () => void mergeFile(conflicted[0].change.path) } as MenuItem,
          { label: "Accept Yours", action: () => void runOp({ op: "resolveSide", paths: conflicted.map((f) => f.change.path), side: "ours" }, "Resolving") } as MenuItem,
          { label: "Accept Theirs", action: () => void runOp({ op: "resolveSide", paths: conflicted.map((f) => f.change.path), side: "theirs" }, "Resolving") } as MenuItem,
          { separator: true } as MenuItem,
        ]
      : []),
    { label: "Show Diff", disabled: files.length !== 1, action: () => void showLocalDiff(files[0]) },
    {
      label: "Open in Editor",
      shortcut: keymap.shortcut("openInEditor"),
      disabled: files.length !== 1 || files[0].change.status === "D",
      action: () => {
        const p = diff.currentPath === files[0].change.path ? diff.editorPosition() : { line: 1, column: 1 };
        void openInEditor(files[0].change.path, p.line, p.column);
      },
    },
    { label: "Show History", disabled: files.length !== 1 || files[0].list === null || files[0].change.status === "A", action: () => showHistory(files[0].change.old_path ?? files[0].change.path) },
    { label: "Show Local History", disabled: files.length !== 1, action: () => showLocalHistory(files[0].change.path) },
    { label: "Rollback…", shortcut: `${mod}⌥Z`, disabled: !tracked.length, action: () => void rollback(tracked) },
  ];
  if (untracked.length) {
    items.push(
      { label: "Add to Git", action: () => void runOp({ op: "addFiles", paths: untracked.map((f) => f.change.path) }, "Adding files") },
      { label: "Ignore in All Repositories…", action: () => void openSettings("ignore", globalPatterns(untracked.map((f) => f.change.path))) },
      { label: "Delete…", action: () => void deleteUnversioned(untracked) },
    );
  }
  if (tracked.length) {
    items.push({ separator: true }, { header: "Move to Changelist" });
    const paths = tracked.map((f) => f.change.path);
    const from = new Set(tracked.map((f) => f.list));
    for (const l of commitPanel.lists) {
      items.push({ label: l.name + (l.active ? " (active)" : ""), disabled: from.size === 1 && from.has(l.id), action: () => void changeListOp({ op: "move", paths, to: l.id }) });
    }
    items.push({ label: "New Changelist…", action: () => void newChangeList(paths) });
  }
  items.push({ separator: true }, {
    label: "Stash Selected Files…",
    action: () => void stashChanges(files.flatMap((f) => (f.change.old_path ? [f.change.path, f.change.old_path] : [f.change.path])), untracked.length > 0, ""),
  });
  items.push({ separator: true }, { label: files.length > 1 ? "Copy Paths" : "Copy Path", action: () => void copyText(files.map((f) => f.change.path).join("\n")) });
  showMenu(e.clientX, e.clientY, items);
};
commitPanel.onListMenu = (l, e) =>
  showMenu(e.clientX, e.clientY, [
    { label: "Commit Only This Changelist", disabled: !l.changes.length, action: () => { commitPanel.includeOnly(l.id); commitPanel.focusMessage(); } },
    { label: "Set Active Changelist", disabled: l.active, action: () => void changeListOp({ op: "setActive", id: l.id }) },
    { separator: true },
    { label: "New Changelist…", action: () => void newChangeList() },
    { label: "Edit Changelist…", action: () => void editChangeList(l) },
    { label: "Remove Changelist…", disabled: commitPanel.lists.length === 1, action: () => void removeChangeList(l) },
    { separator: true },
    { label: "Stash Changelist…", disabled: !l.changes.length, action: () => void stashChanges(l.changes.flatMap((c) => (c.old_path ? [c.path, c.old_path] : [c.path])), false, l.name) },
    { label: "Rollback…", disabled: !l.changes.length, action: () => void rollback(l.changes.map((c) => ({ key: `f:${c.path}`, change: c, list: l.id }))) },
  ]);
commitPanel.onUnversionedMenu = (e) => {
  showMenu(e.clientX, e.clientY, [
    { label: "Add All to Git", action: () => void api.localChanges().then((lc) => runOp({ op: "addFiles", paths: lc.unversioned }, "Adding files")) },
    { label: "Delete All…", action: () => void api.localChanges().then((lc) => deleteUnversioned(lc.unversioned.map((p) => ({ key: `u:${p}`, change: { status: "?", path: p, old_path: null }, list: null })))) },
  ]);
};
