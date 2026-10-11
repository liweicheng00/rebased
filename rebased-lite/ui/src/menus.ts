// The context menus of the log, the branches and the changed files.

import { api, type BranchInfo, type Row } from "./api";
import { WORKTREE } from "./compare-view";
import { menuBelow, type MenuItem, showMenu } from "./context-menu";
import { confirmDialog } from "./dialogs";
import { copyText } from "./dom";
import { showHistory } from "./history-flow";
import { openInEditor } from "./editor-flow";
import { keymap } from "./keyboard";
import { toast } from "./notify";
import { addWorktree, checkoutBranch, checkoutCommit, currentBranch, deleteBranch, deleteRefs, deleteMergedBranches, interactiveRebase, mergeIntoCurrent, newBranch, newTag, rebaseCurrentOnto, renameBranch, resetTo, rewriteSelected, runOp } from "./operations";
import { compareBranches, fetchRemote, manageRemotes, openOnRemote, remoteRefItems, toggleFavorite } from "./remotes";
import { startReview } from "./review-flow";
import { askForRepo, cloneRepo, fetchAll, jumpToOid, openRepo, refresh, reloadView } from "./repo";
import { collapse, compare, comparedCommits, compareWithWorktree, fileChangesAction, openFile, short, showSelection } from "./selection";
import { settings } from "./settings";
import { changes, diff, fetchBtn, filterBar, log, openBtn, refreshBtn, sidebar, statusActivity, toggleDiff } from "./shell";
import { app } from "./state";
import { pushBranch, updateBranch } from "./sync";

async function rowMenu(r: Row, e: MouseEvent) {
  const rows = await log.selectedRows();
  if (!rows.length) rows.push(r);
  const multi = rows.length > 1;
  const cur = currentBranch();
  const items: MenuItem[] = [
    { label: multi ? "Copy Revision Numbers" : "Copy Revision Number", shortcut: keymap.shortcut("copyHash"), action: () => void copyText(multi ? rows.map((s) => s.oid).join(" ") : r.oid) },
    { label: "Copy Subject", action: () => void copyText(r.subject) },
    { label: "Open Commit in the Browser", disabled: multi, action: () => void openOnRemote({ oid: r.oid }) },
    { separator: true },
    { label: "Compare with Parent", action: () => log.select([r.row]) },
    { label: "Compare with Working Tree", action: () => compareWithWorktree(r) },
  ];
  if (rows.length === 2) items.push({ label: "Compare Selected Commits", action: () => showSelection(rows) });
  items.push({ separator: true }, { header: "Branch" });
  items.push(
    { label: "Checkout Revision…", disabled: multi, action: () => void checkoutCommit(r.oid) },
    { label: "New Branch…", disabled: multi, action: () => void newBranch(r.oid, short(r.oid)) },
    { label: "New Tag…", disabled: multi, action: () => void newTag(r.oid, short(r.oid)) },
    { label: "New Worktree…", disabled: multi, action: () => void addWorktree(r.oid, short(r.oid)) },
    { label: `Merge into ${cur ?? "current"}`, disabled: multi || !cur || r.isHead, action: () => void mergeIntoCurrent(r.oid, short(r.oid)) },
    { label: `Rebase ${cur ?? "current"} onto Here…`, disabled: multi || !cur || r.isHead, action: () => void rebaseCurrentOnto(r.oid, short(r.oid)) },
    { label: `Reset ${cur ?? "HEAD"} to Here…`, disabled: multi, action: () => void resetTo(r.oid) },
  );
  items.push({ separator: true }, { header: "Commits" });
  items.push(
    { label: multi ? `Cherry-Pick ${rows.length} Commits` : "Cherry-Pick", action: () => void runOp({ op: "cherryPick", oids: [...rows].reverse().map((s) => s.oid) }, "Cherry-picking") },
    { label: multi ? `Revert ${rows.length} Commits` : "Revert Commit", action: () => void runOp({ op: "revert", oids: rows.map((s) => s.oid) }, "Reverting") },
    { label: "Edit Commit Message…", disabled: multi, action: () => void rewriteSelected("reword", [r]) },
    { label: multi ? `Edit Author of ${rows.length} Commits…` : "Edit Author…", action: () => void rewriteSelected("author", rows) },
    { label: multi ? `Squash ${rows.length} Commits…` : "Squash Commits… (select 2 or more)", disabled: !multi, action: () => void rewriteSelected("squash", rows) },
    { label: multi ? `Drop ${rows.length} Commits…` : "Drop Commit…", action: () => void rewriteSelected("drop", rows.length ? rows : [r]) },
    { label: "Interactively Rebase from Here…", disabled: multi, action: () => void interactiveRebase(r) },
  );
  items.push({ separator: true }, { header: "Graph" });
  items.push(
    { label: "Collapse Linear Branch Here", action: () => void collapse("row", r.row) },
    { label: "Collapse All Linear Branches", action: () => void collapse("all") },
    { label: "Expand All Linear Branches", disabled: !app.view?.collapsed, action: () => void collapse("none") },
    { label: "Go to Parent", action: () => void api.commit(r.oid).then((c) => (c.parents[0] ? jumpToOid(c.parents[0], true) : false)) },
    { label: "Go to Child", action: () => void goToChild(r.oid) },
  );
  items.push({ separator: true }, { header: "Filter" });
  items.push({ label: `Show Commits by ${r.author}`, action: () => filterBar.set({ ...filterBar.filter, author: r.author }, true) });
  for (const ref of r.refs.filter((x) => x.kind === "local" || x.kind === "remote")) {
    items.push({ label: `Show Only ${ref.name}`, action: () => filterBar.set({ ...filterBar.filter, branches: [ref.name] }, true) });
  }
  showMenu(e.clientX, e.clientY, items);
}
log.onContextMenu = (r, e) => void rowMenu(r, e);

/** Goes to the child of a commit. With more than one child, a menu asks which one. */
async function goToChild(oid: string) {
  const kids = await api.children(oid).catch(() => [] as string[]);
  if (!kids.length) return toast("This commit has no child in the log.", "info");
  if (kids.length === 1) return void jumpToOid(kids[0], true);
  const infos = await Promise.all(kids.map((k) => api.commit(k).catch(() => null)));
  const at = document.querySelector(".log-row.selected")?.getBoundingClientRect();
  showMenu(at ? at.left + 200 : 200, at ? at.bottom : 200, [
    { header: `${kids.length} children` },
    ...kids.map((k, i) => ({ label: `${k.slice(0, 8)}  ${infos[i]?.subject ?? ""}`, action: () => void jumpToOid(k, true) })),
  ]);
}

sidebar.onLocalMenu = (e) => showMenu(e.clientX, e.clientY, [{ label: "Delete Merged Branches…", action: () => void deleteMergedBranches() }]);
sidebar.onNavigate = (b) => void jumpToOid(b.oid, true);
sidebar.onToggleFilter = (b) => filterBar.toggleBranch(b.name);
log.onRefClick = (name) => {
  void copyText(name);
  statusActivity.textContent = `Copied ${name}`;
};
log.onRefDoubleClick = async (name, r) => {
  filterBar.onlyBranch(name, false);
  await reloadView();
  await jumpToOid(r.oid, true);
};
sidebar.onContextMenu = (b, e) => {
  const current = app.refs.find((x) => x.current);
  const cur = currentBranch();
  const isCurrent = b.current;
  showMenu(e.clientX, e.clientY, [
    { label: b.kind === "remote" ? "Checkout as Local Branch" : "Checkout", disabled: isCurrent, action: () => void checkoutBranch(b) },
    { label: "New Branch from Here…", action: () => void newBranch(b.oid, b.name) },
    { label: "New Worktree…", action: () => void addWorktree(b.kind === "local" ? b.name : b.oid, b.name) },
    { separator: true },
    { label: "Push…", disabled: b.kind !== "local", action: () => void pushBranch(b.name) },
    { label: "Update", disabled: !isCurrent || !b.upstream, action: () => void updateBranch() },
    ...remoteRefItems(b),
    { separator: true },
    { label: `Merge into ${cur ?? "current"}`, disabled: isCurrent || !cur, action: () => void mergeIntoCurrent(b.name, b.name) },
    { label: `Rebase ${cur ?? "current"} onto ${b.name}…`, disabled: isCurrent || !cur, action: () => void rebaseCurrentOnto(b.name, b.name) },
    { label: `Compare Branches: ${cur ?? "HEAD"} and ${b.name}…`, disabled: isCurrent, action: () => compareBranches(cur ?? "HEAD", b.name) },
    { label: "Compare with the Working Tree…", action: () => compareBranches(b.name, WORKTREE) },
    {
      label: `Compare with ${current ? current.name : "HEAD"}`,
      disabled: !app.view?.headOid || b.oid === app.view?.headOid,
      action: () => app.view?.headOid && void compare({ commit: app.view.headOid }, { commit: b.oid }, `${current?.name ?? "HEAD"} → ${b.name}`, current?.name ?? "HEAD", b.name),
    },
    { separator: true },
    { label: "Go to Commit", action: () => void jumpToOid(b.oid, true) },
    { label: filterBar.filter.branches.includes(b.name) ? "Remove from Log Filter" : "Show Only This Branch", action: () => filterBar.toggleBranch(b.name) },
    {
      label: `Show Commits Not in ${cur ?? "HEAD"}`,
      disabled: isCurrent || !app.view?.headOid,
      action: () => filterBar.set({ ...filterBar.filter, branches: [b.name, `^${cur ?? "HEAD"}`] }, true),
    },
    {
      label: `Show Commits of ${cur ?? "HEAD"} Not in ${b.name}`,
      disabled: isCurrent || !app.view?.headOid,
      action: () => filterBar.set({ ...filterBar.filter, branches: [cur ?? "HEAD", `^${b.name}`] }, true),
    },
    { separator: true },
    { label: "Review Branch…", disabled: b.kind === "tag", action: () => void startReview(b.name) },
    { separator: true },
    { label: "Rename…", disabled: b.kind !== "local", action: () => void renameBranch(b) },
    { label: b.kind === "tag" ? "Delete Tag…" : "Delete…", disabled: b.kind === "remote" || isCurrent, action: () => void deleteBranch(b) },
    ...(b.kind === "tag"
      ? []
      : [
          {
            label: `Delete Branches Merged into ${b.name}…`,
            action: () => void deleteMergedBranches({ mode: "into", value: b.name }),
          },
        ]),
    { label: sidebar.isFavorite(b) ? "Remove from Favorites" : "Add to Favorites", action: () => toggleFavorite(b) },
    { label: "Copy Name", action: () => void copyText(b.name) },
    { label: "Copy Revision Number", action: () => void copyText(b.oid) },
  ]);
};
/** The menu of two or more branches and tags in the branches panel. */
sidebar.onMultiMenu = (refs, e) => {
  const names = refs.map((b) => b.name);
  const locals = refs.filter((b) => b.kind === "local");
  const remotes = refs.filter((b) => b.kind === "remote");
  const deletable = refs.filter((b) => (b.kind === "local" && !b.current) || b.kind === "tag");
  const pushable = locals.filter((b) => b.upstream);
  const allFavorite = refs.every((b) => sidebar.isFavorite(b));
  const n = (k: number, one: string, many: string) => (k === 1 ? one : `${k} ${many}`);
  // Only the actions that apply to the selection show.
  const items: MenuItem[] = [{ header: `${refs.length} selected` }, { label: "Show Only These in the Log", action: () => filterBar.set({ ...filterBar.filter, branches: names }, true) }];
  if (refs.length === 2) items.push({ label: `Compare Branches: ${names[0]} and ${names[1]}…`, action: () => compareBranches(names[0], names[1]) });
  const writes: MenuItem[] = [];
  if (pushable.length) writes.push({ label: `Push ${n(pushable.length, "1 Branch", "Branches")} to Their Tracked Branches…`, action: () => void pushTracked(pushable) });
  if (deletable.length) writes.push({ label: `Delete ${n(deletable.length, "1 Branch or Tag", "Branches and Tags")}…`, action: () => void deleteRefs(deletable) });
  if (remotes.length) writes.push({ label: `Delete ${n(remotes.length, "1 Remote Branch", "Remote Branches")} from Their Remotes…`, action: () => void deleteRemoteBranches(remotes) });
  if (writes.length) items.push({ separator: true }, ...writes);
  items.push(
    { separator: true },
    {
      label: allFavorite ? "Remove from Favorites" : "Add to Favorites",
      action: () => {
        for (const b of refs) if (sidebar.isFavorite(b) === allFavorite) toggleFavorite(b);
      },
    },
    { label: "Copy Names", action: () => void copyText(names.join("\n")) },
  );
  showMenu(e.clientX, e.clientY, items);
};

/** Pushes each branch to its tracked branch, after one question. */
async function pushTracked(branches: BranchInfo[]) {
  const list = branches.map((b) => `${b.name} → ${b.upstream}`);
  if (!(await confirmDialog(`Push ${branches.length} branches`, "Push each branch to its tracked branch?", "Push", false, list))) return;
  for (const b of branches) {
    const up = b.upstream!;
    const slash = up.indexOf("/");
    const out = await runOp({ op: "push", branch: b.name, remote: up.slice(0, slash), remoteBranch: up.slice(slash + 1), force: false, setUpstream: false, tags: false }, `Pushing ${b.name}`);
    if (!out?.result.ok) return;
  }
}

/** Deletes remote branches on their remotes, after one question. */
async function deleteRemoteBranches(refs: BranchInfo[]) {
  if (!(await confirmDialog(`Delete ${refs.length} remote branches`, "Delete these branches on their remotes? Other people lose them too when they fetch.", "Delete", true, refs.map((b) => b.name)))) return;
  for (const b of refs) {
    const slash = b.name.indexOf("/");
    const out = await runOp({ op: "deleteRemoteRef", remote: b.name.slice(0, slash), name: `refs/heads/${b.name.slice(slash + 1)}` }, `Deleting ${b.name}`);
    if (!out?.result.ok) return;
  }
}

changes.onContextMenu = (files, e) => {
  const c = files[0];
  const commits = !!comparedCommits() && files.every((f) => !f.rightRev);
  const plural = files.length > 1 ? ` (${files.length} files)` : "";
  showMenu(e.clientX, e.clientY, [
    {
      label: "Show Diff",
      disabled: files.length !== 1,
      action: () => {
        toggleDiff(true);
        void openFile(app.changeList.indexOf(c));
      },
    },
    {
      label: "Open in Editor",
      shortcut: keymap.shortcut("openInEditor"),
      disabled: files.length !== 1 || c.status === "D",
      action: () => {
        const p = diff.currentPath === c.path ? diff.editorPosition() : { line: 1, column: 1 };
        void openInEditor(c.path, p.line, p.column);
      },
    },
    { label: "Show History", disabled: files.length !== 1 || c.status === "D", action: () => showHistory(c.path) },
    { separator: true },
    { label: `Revert Selected Changes${plural}`, disabled: !commits, action: () => void fileChangesAction(files, "revert") },
    { label: `Cherry-Pick Selected Changes${plural}`, disabled: !commits, action: () => void fileChangesAction(files, "pick") },
    { label: `Get from Revision${plural}…`, disabled: !commits, action: () => void fileChangesAction(files, "get") },
    { separator: true },
    { label: files.length > 1 ? "Copy Paths" : "Copy Path", action: () => void copyText(files.map((f) => f.path).join("\n")) },
    { label: "Copy File Name", disabled: files.length !== 1, action: () => void copyText(c.path.split("/").pop() ?? c.path) },
  ]);
};

openBtn.addEventListener("click", () =>
  menuBelow(openBtn, [
    { label: "Open Repository…", shortcut: keymap.shortcut("open"), action: () => void askForRepo() },
    { label: "Clone Repository…", action: () => void cloneRepo() },
    ...(settings.recent.length ? [{ separator: true } as MenuItem, { header: "Recent" } as MenuItem] : []),
    ...settings.recent.map((p) => ({ label: p, action: () => void openRepo(p) })),
  ]),
);
refreshBtn.addEventListener("click", () => void refresh());
fetchBtn.addEventListener("click", async () => {
  const remotes = await api.remotes().catch(() => []);
  menuBelow(fetchBtn, [
    { label: "Fetch All Remotes", shortcut: keymap.shortcut("fetch"), disabled: !remotes.length, action: () => void fetchAll() },
    ...(remotes.length > 1 ? [{ separator: true } as MenuItem, ...remotes.map((r) => ({ label: `Fetch ${r.name}`, action: () => void fetchRemote(r.name) }) as MenuItem)] : []),
    { separator: true },
    { label: "Manage Remotes…", action: () => void manageRemotes() },
  ]);
});
