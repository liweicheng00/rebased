// The context menus of the log, the branches and the changed files.

import { api, type Row } from "./api";
import { WORKTREE } from "./compare-view";
import { menuBelow, type MenuItem, showMenu } from "./context-menu";
import { copyText } from "./dom";
import { showHistory } from "./history-flow";
import { keymap } from "./keyboard";
import { addWorktree, checkoutBranch, checkoutCommit, currentBranch, deleteBranch, deleteMergedBranches, interactiveRebase, mergeIntoCurrent, newBranch, newTag, rebaseCurrentOnto, renameBranch, resetTo, rewriteSelected, runOp } from "./operations";
import { compareBranches, fetchRemote, manageRemotes, remoteRefItems, toggleFavorite } from "./remotes";
import { startReview } from "./review-flow";
import { askForRepo, fetchAll, jumpToOid, openRepo, refresh } from "./repo";
import { collapse, compare, comparedCommits, compareWithWorktree, fileChangesAction, openFile, short, showSelection } from "./selection";
import { settings } from "./settings";
import { changes, fetchBtn, filterBar, log, openBtn, refreshBtn, sidebar, toggleDiff } from "./shell";
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
    { separator: true },
    { label: "Compare with Parent", action: () => log.select([r.row]) },
    { label: "Compare with Working Tree", action: () => compareWithWorktree(r) },
  ];
  if (rows.length === 2) items.push({ label: "Compare Selected Commits", action: () => showSelection(rows) });
  items.push({ separator: true }, { header: "Branch" });
  items.push(
    { label: "Check Out Revision…", disabled: multi, action: () => void checkoutCommit(r.oid) },
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
  );
  items.push({ separator: true }, { header: "Filter" });
  items.push({ label: `Show Commits by ${r.author}`, action: () => filterBar.set({ ...filterBar.filter, author: r.author }, true) });
  for (const ref of r.refs.filter((x) => x.kind === "local" || x.kind === "remote")) {
    items.push({ label: `Show Only ${ref.name}`, action: () => filterBar.set({ ...filterBar.filter, branches: [ref.name] }, true) });
  }
  showMenu(e.clientX, e.clientY, items);
}
log.onContextMenu = (r, e) => void rowMenu(r, e);

sidebar.onLocalMenu = (e) => showMenu(e.clientX, e.clientY, [{ label: "Delete Merged Branches…", action: () => void deleteMergedBranches() }]);
sidebar.onNavigate = (b) => void jumpToOid(b.oid, true);
sidebar.onToggleFilter = (b) => filterBar.toggleBranch(b.name);
sidebar.onContextMenu = (b, e) => {
  const current = app.refs.find((x) => x.current);
  const cur = currentBranch();
  const isCurrent = b.current;
  showMenu(e.clientX, e.clientY, [
    { label: b.kind === "remote" ? "Check Out as Local Branch" : "Check Out", disabled: isCurrent, action: () => void checkoutBranch(b) },
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
    { label: "Review Branch…", disabled: b.kind !== "local", action: () => void startReview(b.name) },
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
