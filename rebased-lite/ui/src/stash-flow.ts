// The Stash tab.

import { api, type RevSpec, type Stash } from "./api";
import { showMenu } from "./context-menu";
import { confirmDialog, formDialog } from "./dialogs";
import { copyText } from "./dom";
import { runOp } from "./operations";
import { loadLocalChanges } from "./repo";
import { openFile, short } from "./selection";
import { changes, commitPanel, details, diff, stashPanel } from "./shell";
import { app } from "./state";

async function showStash(s: Stash) {
  const req = ++app.request;
  app.diffSource = "log";
  commitPanel.setActiveFile(null);
  changes.setTitle(`stash@{${s.index}}: ${s.message}`);
  changes.setMessage("Loading…");
  diff.message("Loading…");
  details.clear();
  try {
    const d = await api.stashDetail(s.index);
    if (req !== app.request) return;
    app.left = { commit: d.base };
    app.rightRev = { commit: d.oid };
    app.active = -1;
    diff.setSides(short(d.base), `stash@{${s.index}}`);
    const untrackedRev: RevSpec | undefined = d.untrackedOid ? { commit: d.untrackedOid } : undefined;
    app.changeList = [...d.changes, ...d.untracked.map((p) => ({ status: "A", path: p, old_path: null, rightRev: untrackedRev }))];
    changes.setChanges(app.changeList);
    if (app.changeList.length) void openFile(changes.firstInOrder());
    else diff.message("The stash has no changes.");
  } catch (e) {
    if (req === app.request) {
      changes.setMessage(String(e));
      diff.message("");
    }
  }
}

export async function stashChanges(paths: string[], hasUntracked: boolean, suggested: string) {
  const all = paths.length === 0;
  const r = await formDialog(all ? "Stash Local Changes" : `Stash ${paths.length} File(s)`, [
    { key: "message", label: "Message", value: suggested },
    { key: "untracked", label: "Include unversioned files", type: "checkbox", value: hasUntracked },
    ...(all ? [{ key: "keepIndex", label: "Keep the staged changes in the working tree", type: "checkbox" as const, value: false }] : []),
  ], "Stash", "The stashed changes are removed from the working tree. Apply or pop the stash later from the Stash tab.");
  if (!r) return;
  await runOp(
    { op: "stashPush", message: String(r.message), paths, includeUntracked: !!r.untracked, keepIndex: !!r.keepIndex },
    "Stashing",
  );
}

async function applyStash(s: Stash, pop: boolean, restoreIndex = false) {
  await runOp({ op: "stashApply", index: s.index, pop, restoreIndex }, pop ? "Popping the stash" : "Applying the stash");
}

stashPanel.onSelect = (s) => void showStash(s);
stashPanel.onRefresh = () => void loadLocalChanges();
stashPanel.onStashAll = () => void stashChanges([], commitPanel.hasUnversioned, "");
stashPanel.onMenu = (s, e) =>
  showMenu(e.clientX, e.clientY, [
    { label: "Apply", action: () => void applyStash(s, false) },
    { label: "Pop", action: () => void applyStash(s, true) },
    { label: "Apply with the Staged State", action: () => void applyStash(s, false, true) },
    { separator: true },
    {
      label: "New Branch from Stash…",
      action: async () => {
        const r = await formDialog(`New branch from stash@{${s.index}}`, [{ key: "name", label: "Branch name", placeholder: "stash-work" }], "Create", "The branch starts at the commit the stash was made on. The stash is applied there and dropped.");
        if (r && String(r.name).trim()) await runOp({ op: "stashBranch", index: s.index, branch: String(r.name).trim() }, "Creating branch");
      },
    },
    {
      label: "Drop…",
      action: async () => {
        if (await confirmDialog("Drop stash", `Drop stash@{${s.index}} "${s.message}"? This cannot be undone.`, "Drop", true)) await runOp({ op: "stashDrop", index: s.index }, "Dropping");
      },
    },
    { separator: true },
    { label: "Copy Message", action: () => void copyText(s.message) },
  ]);
