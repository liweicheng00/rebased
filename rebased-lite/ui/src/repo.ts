// Opening repositories in tabs, loading the log and the refs, and moving in the log.

import { api, type BranchInfo, inTauri, type LogFilter, pickFolder, type RecentBranch, setRepoRoot, type Submodule, type ViewResult, type Worktree } from "./api";
import { h } from "./dom";
import { emptyFilter } from "./filter-bar";
import { loadFavorites } from "./remotes";
import { clearCompare } from "./selection";
import { addRecent, save, settings } from "./settings";
import { authors, banner, commitPanel, fetchBtn, filterBar, localHistoryBtn, log, mod, pushBtn, refreshBtn, remoteBtn, reviewPanel, sidebar, stashPanel, statusActivity, tabBar, tabCommit, tabReviews, tabStash, task, updateBtn, updateStatus } from "./shell";
import { app } from "./state";
import { showWorkspace } from "./welcome";

function viewSettings() {
  return { intelliSort: settings.intelliSort, showLongEdges: settings.showLongEdges, collapseLinear: settings.collapseLinear, filter: filterBar.filter };
}

/** What a tab keeps while another tab is active. */
interface TabState {
  filter: LogFilter;
  selected: string | null;
}
const tabStates = new Map<string, TabState>();

export function renderTabs() {
  tabBar.hidden = settings.tabs.length < 2;
  tabBar.replaceChildren(
    ...settings.tabs.map((root) => {
      const name = root.split(/[\\/]/).pop() ?? root;
      const close = h("button", { class: "tab-close", title: "Close the tab" }, "✕");
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        void closeTab(root);
      });
      const tab = h("div", { class: "tab" + (root === settings.activeTab ? " on" : ""), title: root, role: "tab" }, h("span", { class: "tab-name" }, name), close);
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
  if (target && !app.selected.length) await jumpToOid(target, true);
}

export async function applyView(r: ViewResult, keepSelection: boolean) {
  const keepOids = keepSelection ? app.selected.map((s) => s.oid) : [];
  app.view = r;
  document.title = `${r.root.split(/[\\/]/).pop()} – Rebased Lite`;
  refreshBtn.disabled = fetchBtn.disabled = updateBtn.disabled = pushBtn.disabled = remoteBtn.disabled = localHistoryBtn.disabled = false;
  updateStatus();
  log.setCollapsed(r.collapsed);
  log.reset(r.rowCount, r.recommendedWidth);
  app.selected = [];
  if (keepOids.length) {
    const rows = (await Promise.all(keepOids.map((o) => api.find(o)))).map((f) => f.row).filter((x): x is number => x !== null);
    if (rows.length) {
      log.jumpTo(rows[0], false);
      log.select(rows);
      return;
    }
  }
  clearCompare();
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

export async function jumpToOid(oid: string, select: boolean): Promise<boolean> {
  const f = await api.find(oid);
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
