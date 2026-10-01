// Write operations: runOp, Undo, and the branch, tag, merge, rebase, reset and rewrite flows.

import { api, type BranchInfo, errorHint, inTauri, type Op, type OpOutcome, pickFolder, type PlanEntry, type Row, type Submodule, type Worktree } from "./api";
import { showBranchSwitcher } from "./branch-switcher";
import { mergeFile } from "./conflicts";
import { showMenu } from "./context-menu";
import { confirmDialog, deleteMergedDialog, formDialog, interactiveRebaseDialog, messageDialog, resetDialog } from "./dialogs";
import { copyText } from "./dom";
import { toast } from "./notify";
import { applyView, jumpToOid, loadRefs, openRepo } from "./repo";
import { short } from "./selection";
import { banner, branchBtn, sidebar, statusRight, task } from "./shell";
import { app } from "./state";

/** Runs a write operation, reloads the log, and reports the result. */
export async function runOp(op: Op, label: string, errorAction?: { label: string; run: () => void }): Promise<OpOutcome | undefined> {
  const outcome = await task(label, () => api.runOp(op));
  // The watcher reports the changes of this operation; the view reloads below anyway.
  app.watchQuietUntil = Date.now() + 1500;
  if (!outcome) return undefined;
  await applyView(outcome.view, true);
  await loadRefs();
  const r = outcome.result;
  if (r.ok) {
    app.lastUndo = r.undo.length ? { actions: r.undo, message: r.message } : null;
    toast(r.message, "success", r.undo.length ? { label: "Undo", run: () => void undoLast() } : undefined);
    const stale = outcome.staleSubmodules;
    if (stale.length) {
      const what = stale.length === 1 ? `Submodule ${stale[0]} is` : `${stale.length} submodules are`;
      toast(`${what} not at the commit that this revision records.`, "info", { label: "Update Submodules", run: () => updateSubmodules(stale) });
    }
    statusRight.textContent = r.message;
  } else {
    const hint = errorHint(outcome.errorKind);
    // An operation that stopped halfway can still have Undo steps for the part that it did.
    app.lastUndo = r.undo.length ? { actions: r.undo, message: r.message } : app.lastUndo;
    toast(hint ? `${r.message}\n${hint}` : r.message, "error", errorAction ?? (r.undo.length ? { label: "Undo", run: () => void undoLast() } : undefined));
    statusRight.textContent = r.message;
    statusRight.className = "sb-right error";
  }
  return outcome;
}

/** The undo steps of the last operation, for the toast and for Ctrl+Z. */

export async function undoLast() {
  const u = app.lastUndo;
  if (!u) {
    statusRight.textContent = "There is nothing to undo";
    return;
  }
  app.lastUndo = null;
  await runOp({ op: "undo", actions: u.actions }, `Undoing: ${u.message}`);
}

export const currentBranch = () => app.repoState?.branch ?? app.view?.head?.replace("refs/heads/", "") ?? null;

export async function checkoutBranch(b: BranchInfo) {
  if (b.kind === "tag") return checkoutCommit(b.oid, b.name);
  await runOp({ op: "checkout", target: b.name, kind: b.kind }, `Checking out ${b.name}`);
}

export async function checkoutCommit(oid: string, label = short(oid)) {
  if (!(await confirmDialog("Check out a commit", `HEAD will point to ${label} directly (detached HEAD). New commits will not be on a branch until you create one.`, "Check Out"))) return;
  await runOp({ op: "checkout", target: oid, kind: "commit" }, `Checking out ${label}`);
}

export async function newBranch(at: string, atLabel: string) {
  const r = await formDialog(`New branch from ${atLabel}`, [
    { key: "name", label: "Branch name", placeholder: "feature/my-change" },
    { key: "checkout", label: "Check out the new branch", type: "checkbox", value: true },
  ], "Create");
  if (!r || !String(r.name).trim()) return;
  await runOp({ op: "createBranch", name: String(r.name).trim(), at, checkout: !!r.checkout }, "Creating branch");
}

export async function newTag(at: string, atLabel: string) {
  const r = await formDialog(`New tag on ${atLabel}`, [
    { key: "name", label: "Tag name", placeholder: "v1.0.0" },
    { key: "message", label: "Message (optional; makes an annotated tag)", type: "textarea" },
  ], "Create");
  if (!r || !String(r.name).trim()) return;
  await runOp({ op: "createTag", name: String(r.name).trim(), at, message: String(r.message) }, "Creating tag");
}

export async function mergeIntoCurrent(rev: string, label: string) {
  const cur = currentBranch();
  if (!cur) return toast("HEAD is detached. Check out a branch first.", "error");
  await runOp({ op: "merge", rev }, `Merging ${label} into ${cur}`);
}

export async function rebaseCurrentOnto(rev: string, label: string) {
  const cur = currentBranch();
  if (!cur) return toast("HEAD is detached. Check out a branch first.", "error");
  if (!(await confirmDialog("Rebase", `Rebase ${cur} onto ${label}? The commits of ${cur} get new hashes.`, "Rebase"))) return;
  await runOp({ op: "rebase", onto: rev }, `Rebasing ${cur} onto ${label}`);
}

export async function resetTo(oid: string) {
  const cur = currentBranch() ?? "HEAD";
  const mode = await resetDialog(short(oid), cur);
  if (!mode) return;
  if (mode === "hard" && !(await confirmDialog("Hard reset", "All uncommitted changes in the working tree will be lost. Continue?", "Reset Hard", true))) return;
  await runOp({ op: "reset", to: oid, mode }, `Resetting ${cur}`);
}

/** Selected rows are sorted top to bottom (newest first). */
export async function rewriteSelected(kind: "squash" | "drop" | "reword" | "author", rows: Row[]) {
  const oldest = rows[rows.length - 1];
  let range;
  try {
    range = await api.rewriteRange(`${oldest.oid}^`);
  } catch (e) {
    return toast(String(e).replace(/^Error: /, ""), "error");
  }
  const sel = new Set(rows.map((r) => r.oid));
  if (range.entries.filter((e) => sel.has(e.oid)).length !== sel.size) {
    return toast("Select commits of the current branch only.", "error");
  }
  if (range.published && !(await confirmDialog("Commits are pushed", "Some of these commits are on a remote branch already. After this change you must force-push. Continue?", "Continue", true))) return;
  let plan: PlanEntry[];
  let what: string;
  if (kind === "drop") {
    if (!(await confirmDialog("Drop commits", `Drop ${sel.size} commit(s) from ${currentBranch()}? You can undo this right after.`, "Drop", true))) return;
    plan = range.entries.map((e) => ({ oid: e.oid, action: sel.has(e.oid) ? "drop" : "pick" }));
    what = `Drop ${sel.size} commit(s)`;
  } else if (kind === "author") {
    const chosen = range.entries.filter((e) => sel.has(e.oid));
    const first = chosen[0];
    const r = await formDialog(
      chosen.length > 1 ? `Edit the author of ${chosen.length} commits` : `Edit the author of ${short(first.oid)}`,
      [{ key: "author", label: "Author", value: `${first.author} <${first.authorEmail}>`, placeholder: "Name <email>" }],
      "Save",
      "The author date and the committer stay. The commits after them get new hashes.",
    );
    if (!r) return;
    const author = String(r.author).trim();
    if (!/^[^<>]+<[^<>]+>$/.test(author)) return toast("Write the author as: Name <email>", "error");
    plan = range.entries.map((e) => (sel.has(e.oid) ? { oid: e.oid, action: "pick", author } : { oid: e.oid, action: "pick" }));
    what = "Edit author";
  } else if (kind === "reword") {
    const entry = range.entries.find((e) => e.oid === rows[0].oid)!;
    const message = await messageDialog(`Edit the message of ${short(entry.oid)}`, entry.message, "Save");
    if (!message) return;
    plan = range.entries.map((e) => (e.oid === entry.oid ? { oid: e.oid, action: "reword", message } : { oid: e.oid, action: "pick" }));
    what = "Reword";
  } else {
    const chosen = range.entries.filter((e) => sel.has(e.oid));
    const combined = chosen.map((e) => e.message).join("\n\n");
    const message = await messageDialog(`Squash ${chosen.length} commits`, combined, "Squash", "The commits are joined into one commit at the place of the oldest one.");
    if (!message) return;
    plan = [];
    const first = chosen[0].oid;
    for (const e of range.entries) {
      if (e.oid === first) {
        plan.push({ oid: e.oid, action: "pick", message });
        for (const c of chosen.slice(1)) plan.push({ oid: c.oid, action: "squash", message });
      } else if (!sel.has(e.oid)) {
        plan.push({ oid: e.oid, action: "pick" });
      }
    }
    what = `Squash ${chosen.length} commits`;
  }
  await runOp({ op: "rewrite", base: range.base, plan, what }, what);
}

export async function interactiveRebase(from: Row) {
  let range;
  try {
    range = await api.rewriteRange(`${from.oid}^`);
  } catch (e) {
    return toast(String(e).replace(/^Error: /, ""), "error");
  }
  if (!range.entries.length) return toast("There are no commits to rebase.", "info");
  const plan = await interactiveRebaseDialog(range);
  if (!plan) return;
  await runOp({ op: "rewrite", base: range.base, plan, what: "Interactive rebase" }, "Rebasing");
}

export async function deleteBranch(b: BranchInfo) {
  if (b.kind === "tag") {
    if (await confirmDialog("Delete tag", `Delete the tag ${b.name}?`, "Delete", true)) await runOp({ op: "deleteTag", name: b.name }, "Deleting tag");
    return;
  }
  if (!(await confirmDialog("Delete branch", `Delete the local branch ${b.name}?`, "Delete", true))) return;
  const out = await runOp({ op: "deleteBranch", name: b.name, force: false }, "Deleting branch");
  if (out && !out.result.ok && /not fully merged/.test(out.result.message)) {
    if (await confirmDialog("Branch is not merged", `${b.name} has commits that are not merged. Delete it anyway? The commits can be lost.`, "Delete Anyway", true)) {
      await runOp({ op: "deleteBranch", name: b.name, force: true }, "Deleting branch");
    }
  }
}

/** Delete Merged Branches. The patterns name the tracked branches; `**` means all of them. */
export async function deleteMergedBranches(patterns = "**") {
  const choice = await deleteMergedDialog(patterns, (upstreams) => api.mergedBranches(upstreams));
  if (choice) await runOp({ op: "deleteMerged", ...choice }, "Deleting merged branches");
}

export async function renameBranch(b: BranchInfo) {
  const r = await formDialog(`Rename ${b.name}`, [{ key: "name", label: "New name", value: b.name }], "Rename");
  if (!r || !String(r.name).trim() || r.name === b.name) return;
  await runOp({ op: "renameBranch", from: b.name, to: String(r.name).trim() }, "Renaming branch");
}

export async function addWorktree(at = "HEAD", atLabel = "HEAD") {
  const root = app.view?.root ?? "";
  const r = await formDialog(`New worktree from ${atLabel}`, [
    { key: "branch", label: "Branch", placeholder: "feature/in-worktree" },
    { key: "newBranch", label: "Create this branch (clear to check out an existing branch)", type: "checkbox", value: true },
    { key: "path", label: "Folder", value: `${root}-worktree`, browse: inTauri ? () => pickFolder("Choose the Worktree Folder") : undefined },
    { key: "open", label: "Open the worktree after it is created", type: "checkbox", value: false },
  ], "Create", "An empty branch name creates a worktree with a detached HEAD.");
  if (!r) return;
  const out = await runOp(
    { op: "addWorktree", path: String(r.path).trim(), branch: String(r.branch).trim(), newBranch: !!r.newBranch && !!String(r.branch).trim(), at },
    "Adding worktree",
  );
  if (out?.result.ok && r.open) void openRepo(String(r.path).trim());
}

async function removeWorktree(w: Worktree) {
  if (!(await confirmDialog("Remove worktree", `Remove the worktree at ${w.path}? Its folder is deleted. The branch stays.`, "Remove", true))) return;
  const out = await runOp({ op: "removeWorktree", path: w.path, force: false }, "Removing worktree");
  if (out && !out.result.ok && /modified or untracked|contains/.test(out.result.message)) {
    if (await confirmDialog("Worktree has changes", "The worktree has uncommitted changes. Remove it anyway? The changes are lost.", "Remove Anyway", true)) {
      await runOp({ op: "removeWorktree", path: w.path, force: true }, "Removing worktree");
    }
  }
}

banner.onContinue = () => void runOp({ op: "continue" }, "Continuing");
banner.onAbort = async () => {
  if (await confirmDialog("Abort", `Abort the ${app.repoState?.operation}? The branch returns to where it was before.`, "Abort", true)) {
    await runOp({ op: "abort" }, "Aborting");
  }
};
banner.onMarkResolved = (paths) => void runOp({ op: "markResolved", paths }, "Marking resolved");
banner.onShowFile = (path) => void mergeFile(path);

sidebar.onCheckout = (b) => void checkoutBranch(b);
sidebar.onAddWorktree = () => void addWorktree();
sidebar.onOpenWorktree = (w) => void openRepo(w.path);
const updateSubmodules = (paths: string[]) => void runOp({ op: "updateSubmodules", paths }, "Updating submodules");
const submodulePath = (s: Submodule) => `${app.view?.root ?? ""}/${s.path}`;
sidebar.onUpdateSubmodules = () => updateSubmodules([]);
sidebar.onOpenSubmodule = (s) => void openRepo(submodulePath(s));
sidebar.onSubmoduleMenu = (s, e) =>
  showMenu(e.clientX, e.clientY, [
    { label: "Open as Repository", disabled: s.state === "uninitialized", action: () => void openRepo(submodulePath(s)) },
    { label: s.state === "uninitialized" ? "Initialize and Update" : "Update to the Recorded Commit", action: () => updateSubmodules([s.path]) },
    { separator: true },
    { label: "Copy Path", action: () => void copyText(s.path) },
    { label: "Copy URL", disabled: !s.url, action: () => s.url && void copyText(s.url) },
  ]);
sidebar.onWorktreeMenu = (w, e) =>
  showMenu(e.clientX, e.clientY, [
    { label: "Open", disabled: w.current || w.prunable, action: () => void openRepo(w.path) },
    { label: "Go to Commit", disabled: !w.head, action: () => w.head && void jumpToOid(w.head, true) },
    { label: "Copy Path", action: () => void copyText(w.path) },
    { separator: true },
    { label: "Remove Worktree…", disabled: w.main || w.current, action: () => void removeWorktree(w) },
    { label: "Prune Stale Worktrees", action: () => void runOp({ op: "pruneWorktrees" }, "Pruning worktrees") },
  ]);

branchBtn.addEventListener("click", () =>
  showBranchSwitcher(branchBtn, app.refs, app.recent, {
    checkout: (b) => void checkoutBranch(b),
    newBranch: () => void newBranch("HEAD", currentBranch() ?? "HEAD"),
    menu: (b, e) => sidebar.onContextMenu(b, e),
  }),
);
