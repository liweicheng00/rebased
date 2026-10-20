// Opening repositories in tabs, loading the log and the refs, and moving in the log.

import { api, type BranchInfo, inTauri, type LogFilter, pickFolder, type RecentBranch, type RepoInfo, setRepoRoot, type Submodule, type ViewResult, type Worktree } from "./api";
import { h, icon } from "./dom";
import { emptyFilter } from "./filter-bar";
import { loadFavorites } from "./remotes";
import { clearCompare } from "./selection";
import { addRecent, save, settings } from "./settings";
import { authors, banner, commitPanel, details, fetchBtn, filterBar, localHistoryBtn, log, mod, pushBtn, refreshBtn, remoteBtn, reviewPanel, sidebar, stashPanel, statusActivity, tabBar, tabCommit, tabReviews, tabStash, task, updateBtn, updateStatus } from "./shell";
import { app } from "./state";
import { showWorkspace } from "./welcome";
import { formDialog } from "./dialogs";
import { toast } from "./notify";

function viewSettings() {
  return { intelliSort: settings.intelliSort, showLongEdges: settings.showLongEdges, collapseLinear: settings.collapseLinear, filter: filterBar.filter };
}

/** What a tab keeps while another tab is active. */
interface TabState {
  filter: LogFilter;
  selected: string | null;
}
const tabStates = new Map<string, TabState>();

/** The worktree and branch of each tab, read without a load of the repository. */
const tabInfo = new Map<string, RepoInfo>();
const asking = new Set<string>();

/** Reads the worktree and branch of a tab again, for example after a checkout. */
export async function refreshTabInfo(root: string) {
  const info = await api.repoInfo(root).catch(() => null);
  if (!info || !settings.tabs.includes(root)) return;
  const old = tabInfo.get(root);
  tabInfo.set(root, info);
  // The tab bar draws again only when the tab changes: a new tab bar under the mouse loses a click.
  if (old?.mainRoot !== info.mainRoot || old?.branch !== info.branch) renderTabs();
}

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

export function renderTabs() {
  for (const root of settings.tabs) {
    if (tabInfo.has(root) || asking.has(root)) continue;
    asking.add(root);
    void refreshTabInfo(root).finally(() => asking.delete(root));
  }
  tabBar.hidden = settings.tabs.length < 2;
  tabBar.replaceChildren(
    ...settings.tabs.map((root) => {
      const name = baseName(root);
      const info = tabInfo.get(root);
      // A linked worktree shows the worktree icon and the name of its main repository.
      const worktree = info?.mainRoot ?? null;
      const label = worktree
        ? [icon("worktree", "tab-icon"), h("span", { class: "tab-name" }, name), h("span", { class: "tab-main" }, `of ${baseName(worktree)}`)]
        : [h("span", { class: "tab-name" }, name)];
      const title = [worktree ? `Worktree of ${worktree}` : "", info?.branch ? `Branch: ${info.branch}` : info ? "Detached HEAD" : "", root].filter(Boolean).join("\n");
      const close = h("button", { class: "tab-close", title: "Close the tab" }, icon("close"));
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        void closeTab(root);
      });
      const tab = h("div", { class: "tab" + (root === settings.activeTab ? " on" : "") + (worktree ? " worktree" : ""), title, role: "tab" }, ...label, close);
      tab.addEventListener("mousedown", (e) => {
        if (e.button === 1) {
          e.preventDefault();
          void closeTab(root);
        } else if (e.button === 0 && root !== settings.activeTab) void switchTab(root);
      });
      return tab;
    }),
    (() => {
      const add = h("button", { class: "tab-add", title: `Open a repository in a new tab (${mod}O)` }, "+");
      add.addEventListener("click", () => void askForRepo());
      return add;
    })(),
  );
}

function saveTabState() {
  if (!settings.activeTab || !app.view) return;
  tabStates.set(settings.activeTab, { filter: filterBar.filter, selected: app.selected[0]?.oid ?? null });
}

/** Opens a repository in a new tab, or shows its tab when it is open already. */
export async function openRepo(path: string) {
  const known = settings.tabs.find((t) => t === path);
  if (known && known === settings.activeTab && app.view) return;
  saveTabState();
  const r = await task("Opening repository", () => api.open(path, { ...viewSettings(), filter: emptyFilter() }));
  if (!r) return;
  if (!settings.tabs.includes(r.root)) settings.tabs.push(r.root);
  tabStates.delete(r.root);
  await showRepo(r, null);
}

/** Clone Repository: asks for the URL and the folder, clones, and opens the clone in a new tab. */
export async function cloneRepo() {
  const recentParent = settings.recent[0]?.replace(/[\\/][^\\/]+[\\/]?$/, "") ?? "";
  const f = await formDialog(
    "Clone Repository",
    [
      { key: "url", label: "URL", placeholder: "https://github.com/owner/repo.git or git@github.com:owner/repo.git" },
      { key: "parent", label: "Into the folder", value: settings.cloneDir || recentParent, placeholder: "/path/to/projects", browse: () => pickFolder("Choose the folder for the clone") },
      { key: "name", label: "Folder name", placeholder: "From the URL" },
    ],
    "Clone",
    "A remote that needs a password or a passphrase asks for it. The clone opens in a new tab.",
  );
  if (!f) return;
  const url = String(f.url).trim();
  const parent = String(f.parent).trim();
  app.busy++;
  statusActivity.textContent = `Cloning ${url}…`;
  statusActivity.className = "sb-activity busy";
  try {
    const path = await api.cloneRepo(url, parent, String(f.name));
    statusActivity.textContent = "";
    statusActivity.className = "sb-activity";
    settings.cloneDir = parent;
    save();
    await openRepo(path);
  } catch (e) {
    const message = String(e).replace(/^Error: /, "");
    statusActivity.textContent = "The clone failed";
    statusActivity.className = "sb-activity error";
    toast(`The clone failed: ${message}`, "error");
  } finally {
    app.busy--;
  }
}

export async function switchTab(root: string) {
  saveTabState();
  const state = tabStates.get(root) ?? null;
  const r = await task("Switching repository", () => api.activate(root, { ...viewSettings(), filter: state?.filter ?? emptyFilter() }));
  if (!r) return;
  await showRepo(r, state);
}

async function closeTab(root: string) {
  await showing.catch(() => {});
  await api.close(root).catch(() => {});
  const i = settings.tabs.indexOf(root);
  settings.tabs = settings.tabs.filter((t) => t !== root);
  tabStates.delete(root);
  if (root !== settings.activeTab) {
    save();
    renderTabs();
    return;
  }
  settings.activeTab = null;
  setRepoRoot(null);
  save();
  const next = settings.tabs[Math.min(i, settings.tabs.length - 1)];
  if (next) await switchTab(next);
  else {
    app.view = null;
    commitPanel.clear();
    document.title = "Rebased Lite";
    refreshBtn.disabled = fetchBtn.disabled = updateBtn.disabled = pushBtn.disabled = remoteBtn.disabled = localHistoryBtn.disabled = true;
    renderTabs();
    showWorkspace(false);
  }
}

/** Shows the repository of the active tab. `state` restores the filter and the selection of a tab. */
/** The repository that shows now, while it loads. A tab closes only after it, so no request goes to a
 * repository that is closed. */
let showing: Promise<void> = Promise.resolve();

function showRepo(r: ViewResult, state: TabState | null): Promise<void> {
  showing = loadRepo(r, state);
  return showing;
}

async function loadRepo(r: ViewResult, state: TabState | null) {
  setRepoRoot(r.root);
  settings.activeTab = r.root;
  save();
  renderTabs();
  filterBar.set(state?.filter ?? emptyFilter(), false);
  addRecent(r.root);
  authors.clear();
  app.watchSeen = null;
  app.lastUndo = null;
  sidebar.setRemoteTags(null, null);
  commitPanel.clear();
  showWorkspace(true);
  await applyView(r, false);
  // The watcher counters now are the base: the events after this reload what changed.
  app.watchSeen = await api.watchState().catch(() => null);
  await loadRefs();
  commitPanel.setTemplate(await api.commitTemplate().catch(() => null));
  const target = state?.selected ?? r.headOid;
  // The user can choose a commit while the repository loads; that choice stays.
  if (target && !log.hasSelection()) await jumpToOid(target, true, true);
}

/**
 * Shows a new view of the log. With `keepSelection` it is a reload: the view keeps its place, the same
 * commits stay selected, and the file list and the diff stay as they are. A reload runs after each
 * operation and after a change in the git directory, so it must not move the view of the user.
 */
export async function applyView(r: ViewResult, keepSelection: boolean) {
  const keepOids = keepSelection ? app.selected.map((s) => s.oid) : [];
  const anchor = keepSelection ? log.viewAnchor() : null;
  app.view = r;
  document.title = `${r.root.split(/[\\/]/).pop()} – Rebased Lite`;
  refreshBtn.disabled = fetchBtn.disabled = updateBtn.disabled = pushBtn.disabled = remoteBtn.disabled = localHistoryBtn.disabled = false;
  updateStatus();
  log.setCollapsed(r.collapsed);
  log.reset(r.rowCount, r.recommendedWidth, keepSelection);
  if (anchor) {
    const at = await api.find(anchor.oid).catch(() => null);
    if (at?.row != null) log.scrollToRow(at.row, anchor.offset);
  }
  if (!keepSelection) {
    app.selected = [];
    return clearCompare();
  }
  // Nothing was selected: the file list and the diff, for example of a local change, stay.
  if (!keepOids.length) return;
  const rows = (await Promise.all(keepOids.map((o) => api.find(o)))).map((f) => f.row).filter((x): x is number => x !== null);
  if (rows.length === keepOids.length) {
    log.restoreSelection(rows);
    app.selected = await log.selectedRows();
    // The labels of the commits can change, so the details load again; the files and the diff stay.
    void details.show(app.selected);
    return;
  }
  // Some selected commits are gone, for example after an amend: a new selection.
  app.selected = [];
  if (rows.length) {
    log.jumpTo(rows[0], false);
    log.select(rows);
  } else clearCompare();
}

export async function loadRefs() {
  const [r, rec, wt, st, subs] = await Promise.all([
    api.refs().catch(() => [] as BranchInfo[]),
    api.recentBranches().catch(() => [] as RecentBranch[]),
    api.worktrees().catch(() => [] as Worktree[]),
    api.repoState().catch(() => null),
    api.submodules().catch(() => [] as Submodule[]),
  ]);
  try {
    app.refs = r;
    app.recent = rec;
    app.worktrees = wt;
    app.repoState = st;
    sidebar.setRefs(app.refs);
    sidebar.setRecent(app.recent);
    sidebar.setWorktrees(app.worktrees);
    sidebar.setSubmodules(subs);
    await loadFavorites();
    // The tooltip of the tab names the branch; a checkout changes it.
    if (app.view) void refreshTabInfo(app.view.root);
    log.myEmail = (await api.userEmail().catch(() => "")).toLowerCase();
    banner.update(app.repoState);
    filterBar.branchNames = app.refs.filter((b) => b.kind !== "tag").map((b) => b.name);
    updateStatus();
  } catch (e) {
    // The local changes still load.
    console.error("Loading the branches failed", e);
  }
  await loadLocalChanges();
}

export async function loadLocalChanges() {
  try {
    commitPanel.set(await api.localChanges().catch(async () => {
      // One retry: the first call can meet a repository that is still opening.
      await new Promise((r) => setTimeout(r, 400));
      return api.localChanges();
    }));
  } catch (e) {
    commitPanel.clear(`The local changes could not be loaded: ${String(e).replace(/^Error: /, "")}`);
  }
  const n = commitPanel.changeCount;
  tabCommit.replaceChildren("Changes", n ? h("span", { class: "lp-count" }, String(n)) : "");
  try {
    stashPanel.set(await api.stashes());
  } catch {
    stashPanel.set([]);
  }
  tabStash.replaceChildren("Stash", stashPanel.count ? h("span", { class: "lp-count" }, String(stashPanel.count)) : "");
  await loadReviews();
}

/** Loads the reviews for the Reviews tab. The count on the tab is the reviews that are not merged. */
export async function loadReviews() {
  try {
    reviewPanel.set(await api.reviews());
  } catch {
    reviewPanel.set([]);
  }
  tabReviews.replaceChildren("Reviews", reviewPanel.open ? h("span", { class: "lp-count" }, String(reviewPanel.open)) : "");
}

export async function reloadView() {
  const r = await task("Updating the log", () => api.setView(viewSettings()));
  if (r) await applyView(r, true);
  sidebar.setFilter(filterBar.filter.branches);
}

export async function refresh() {
  if (!app.view) return;
  const r = await task("Refreshing", () => api.refresh());
  if (r) {
    await applyView(r, true);
    await loadRefs();
  }
}

export async function fetchAll() {
  if (!app.view) return;
  const r = await task("Fetching all remotes", () => api.fetch());
  if (r) {
    await applyView(r, true);
    await loadRefs();
    statusActivity.textContent = "Fetch finished";
    void loadRemoteTags();
  }
}

/** Asks a remote for its tags, so the Tags group marks the tags that are only local. It needs the network,
 * so it runs after a fetch, after a push of tags, and on request. Without `remote`: the remote of the
 * current branch, else origin, else the first remote. */
export async function loadRemoteTags(remote?: string) {
  const root = app.view?.root;
  const cur = app.refs.find((b) => b.current);
  let name = remote ?? cur?.upstream?.split("/")[0];
  if (!name) {
    const remotes = (await api.remotes().catch(() => [])).map((r) => r.name);
    name = remotes.includes("origin") ? "origin" : remotes[0];
  }
  if (!name) return sidebar.setRemoteTags(null, null);
  try {
    const tags = await api.remoteTags(name);
    if (app.view?.root === root) sidebar.setRemoteTags(name, tags);
  } catch {
    if (app.view?.root === root) sidebar.setRemoteTags(null, null);
  }
}

/** Shows a commit in the log, and selects it when `select` is set. With `unlessChosen`, it does nothing
 * when the user chose a commit while the log looked for this one. */
export async function jumpToOid(oid: string, select: boolean, unlessChosen = false): Promise<boolean> {
  const f = await api.find(oid);
  if (unlessChosen && log.hasSelection()) return false;
  if (f.row === null) {
    if (f.oid) statusActivity.textContent = `Commit ${f.oid.slice(0, 8)} is hidden by the current filter.`;
    return false;
  }
  if (f.rowCount !== null && app.view) {
    // Finding the commit expanded a collapsed branch.
    app.view = { ...app.view, rowCount: f.rowCount };
    log.reset(f.rowCount, app.view.recommendedWidth, true);
    updateStatus();
  }
  log.jumpTo(f.row, select);
  return true;
}

export async function askForRepo() {
  const picked = await pickFolder();
  if (picked) return void openRepo(picked);
  if (!inTauri) showPathDialog();
}

function showPathDialog() {
  const input = h("input", { class: "dialog-input", placeholder: "/path/to/repository", spellcheck: false, value: settings.recent[0] ?? "" });
  const close = () => overlay.remove();
  const ok = h("button", { class: "primary" }, "Open");
  const cancel = h("button", {}, "Cancel");
  const overlay = h(
    "div",
    { class: "overlay" },
    h("div", { class: "dialog" }, h("div", { class: "dialog-title" }, "Open Git Repository"), input, h("div", { class: "dialog-buttons" }, cancel, ok)),
  );
  ok.addEventListener("click", () => {
    close();
    void openRepo(input.value.trim());
  });
  cancel.addEventListener("click", close);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") ok.click();
    if (e.key === "Escape") close();
  });
  document.body.append(overlay);
  input.focus();
  input.select();
}
