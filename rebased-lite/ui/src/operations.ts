// Write operations: runOp, Undo, and the branch, tag, merge, rebase, reset and rewrite flows.

import { allowRewrite } from "./protected";
import { api, type BranchInfo, errorHint, inTauri, type Op, type OpOutcome, pickFolder, type PlanEntry, type Row, type Submodule, type Worktree } from "./api";
import { showBranchSwitcher } from "./branch-switcher";
import { mergeFile } from "./conflicts";
import { showMenu } from "./context-menu";
import { confirmDialog, deleteMergedDialog, formDialog, interactiveRebaseDialog, messageDialog, removeWorktreeDialog, resetDialog } from "./dialogs";
import { copyText } from "./dom";
import { toast } from "./notify";
import { applyView, jumpToOid, loadRefs, openRepo } from "./repo";
import { short } from "./selection";
import { banner, branchBtn, sidebar, statusActivity, task } from "./shell";
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
    statusActivity.textContent = r.message;
  } else {
    const hint = errorHint(outcome.errorKind);
    // An operation that stopped halfway can still have Undo steps for the part that it did.
    app.lastUndo = r.undo.length ? { actions: r.undo, message: r.message } : app.lastUndo;
    toast(hint ? `${r.message}\n${hint}` : r.message, "error", errorAction ?? (r.undo.length ? { label: "Undo", run: () => void undoLast() } : undefined));
    statusActivity.textContent = r.message;
    statusActivity.className = "sb-activity error";
  }
  return outcome;
}

/** The undo steps of the last operation, for the toast and for Ctrl+Z. */

export async function undoLast() {
  const u = app.lastUndo;
  if (!u) {
    statusActivity.textContent = "There is nothing to undo";
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
  if (!(await confirmDialog("Checkout a commit", `HEAD will point to ${label} directly (detached HEAD). New commits will not be on a branch until you create one.`, "Checkout"))) return;
  await runOp({ op: "checkout", target: oid, kind: "commit" }, `Checking out ${label}`);
}

export async function newBranch(at: string, atLabel: string) {
  const r = await formDialog(`New branch from ${atLabel}`, [
    { key: "name", label: "Branch name", placeholder: "feature/my-change" },
    { key: "checkout", label: "Checkout the new branch", type: "checkbox", value: true },
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
  if (!cur) return toast("HEAD is detached. Checkout a branch first.", "error");
  const r = await formDialog(
    `Merge ${label} into ${cur}`,
    [
      {
        key: "kind",
        label: "How",
        type: "select",
        value: "",
        options: [
          ["", "Fast-forward when possible, else a merge commit"],
          ["noFf", "Always a merge commit (--no-ff)"],
          ["ffOnly", "Only a fast-forward (--ff-only)"],
          ["squash", "Squash: the changes become local changes (--squash)"],
        ],
      },
      { key: "message", label: "Message of the merge commit (empty: the message of git)", placeholder: `Merge ${label}` },
      { key: "noCommit", label: "Stop before the merge commit, so you can check it first (--no-commit)", type: "checkbox", value: false },
      { key: "allowUnrelated", label: "Allow a branch without a common commit (--allow-unrelated-histories)", type: "checkbox", value: false },
    ],
    "Merge",
  );
  if (!r) return;
  const kind = String(r.kind ?? "");
  const options = { noFf: kind === "noFf", ffOnly: kind === "ffOnly", squash: kind === "squash", noCommit: !!r.noCommit, allowUnrelated: !!r.allowUnrelated, message: String(r.message ?? "") };
  await runOp({ op: "merge", rev, options }, `Merging ${label} into ${cur}`);
}

export async function rebaseCurrentOnto(rev: string, label: string) {
  const cur = currentBranch();
  if (!cur) return toast("HEAD is detached. Checkout a branch first.", "error");
  const r = await formDialog(
    `Rebase ${cur} onto ${label}`,
    [
      { key: "from", label: "Only the commits after (git rebase --onto; empty: all commits that the target does not have)", placeholder: "for example main" },
      { key: "updateRefs", label: "Update refs: move the other branches on these commits too (--update-refs)", type: "checkbox", value: false },
      { key: "rebaseMerges", label: "Keep the merge commits (--rebase-merges)", type: "checkbox", value: false },
      { key: "keepEmpty", label: "Keep empty commits (--keep-empty)", type: "checkbox", value: false },
      { key: "autosquash", label: "Autosquash: join fixup! and squash! commits into their commits (--autosquash)", type: "checkbox", value: false },
    ],
    "Rebase",
    `The commits of ${cur} get new hashes.`,
  );
  if (!r) return;
  const options = { from: String(r.from ?? "").trim(), updateRefs: !!r.updateRefs, rebaseMerges: !!r.rebaseMerges, keepEmpty: !!r.keepEmpty, autosquash: !!r.autosquash };
  await runOp({ op: "rebase", onto: rev, options }, `Rebasing ${cur} onto ${label}`);
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
  if (!(await allowRewrite(oldest.oid))) return;
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
  if (!(await allowRewrite(from.oid))) return;
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

/** Deletes several local branches and tags in one operation. A branch that is not merged asks again.
 * Undo then creates all of them again. */
export async function deleteRefs(refs: BranchInfo[]) {
  const branches = refs.filter((b) => b.kind === "local" && !b.current).map((b) => b.name);
  const tags = refs.filter((b) => b.kind === "tag").map((b) => b.name);
  const names = [...branches.map((n) => `branch ${n}`), ...tags.map((n) => `tag ${n}`)];
  if (!names.length) return;
  if (!(await confirmDialog(`Delete ${names.length} branches and tags`, "Delete these branches and tags? Undo creates them again.", "Delete", true, names))) return;
  const out = await runOp({ op: "deleteRefs", branches, tags, force: false }, "Deleting branches and tags");
  const m = out && !out.result.ok ? /^Not merged, so kept: (.*)$/m.exec(out.result.message) : null;
  if (!m || !out) return;
  const open = m[1].split(", ");
  const first = out.result.undo;
  const what = open.length === 1 ? `${open[0]} has commits` : `${open.join(", ")} have commits`;
  if (!(await confirmDialog("Branches are not merged", `${what} that are not merged. Delete anyway? The commits can be lost.`, "Delete Anyway", true))) return;
  const again = await runOp({ op: "deleteRefs", branches: open, tags: [], force: true }, "Deleting branches");
  // One Undo creates the refs of both steps again.
  if (again?.result.ok && app.lastUndo) app.lastUndo = { actions: [...first, ...app.lastUndo.actions], message: `Deleted ${branches.length + tags.length} branches and tags` };
}

/** Delete Merged Branches. "into" starts with the branches merged into a branch (the current branch by
 * default); "tracked" starts with tracked-branch patterns, where `**` means all of them. */
export async function deleteMergedBranches(start: { mode: "into" | "tracked"; value?: string } = { mode: "into" }) {
  const locals = app.refs.filter((b) => b.kind === "local").map((b) => b.name);
  const remotes = app.refs.filter((b) => b.kind === "remote").map((b) => b.name);
  const value = start.value ?? (start.mode === "into" ? currentBranch() ?? locals[0] ?? "" : "**");
  const choice = await deleteMergedDialog({ mode: start.mode, value }, [...locals, ...remotes], {
    into: (target) => api.mergedInto(target),
    tracked: (upstreams) => api.mergedBranches(upstreams),
  });
  if (!choice) return;
  if (choice.mode === "into") await runOp({ op: "deleteMergedInto", target: choice.target, names: choice.names }, "Deleting merged branches");
  else await runOp({ op: "deleteMerged", upstreams: choice.upstreams, keep: choice.keep, expected: choice.expected }, "Deleting merged branches");
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
    { key: "newBranch", label: "Create this branch (clear to checkout an existing branch)", type: "checkbox", value: true },
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

/** Removes a worktree, after a check of what stops git: files, submodules and a lock. */
async function removeWorktree(w: Worktree) {
  const b = await api.worktreeBlockers(w.path).catch(() => null);
  if (!(await removeWorktreeDialog(w.path, b))) return;
  const force = !!(b && (b.files.length || b.submodules));
  const out = await runOp({ op: "removeWorktree", path: w.path, force, unlock: b?.locked != null }, "Removing worktree");
  if (out && !out.result.ok) toast(`The worktree stays. Git says: ${out.result.message}`, "error");
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
