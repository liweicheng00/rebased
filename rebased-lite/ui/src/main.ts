import "./style.css";
import {
  api,
  initialPath,
  inTauri,
  pickFile,
  pickFolder,
  type BranchInfo,
  type Change,
  type ChangeListView,
  type Op,
  type OpOutcome,
  type LogFilter,
  type PlanEntry,
  type Submodule,
  type UndoAction,
  type RecentBranch,
  type RepoState,
  type RevSpec,
  type Stash,
  type Row,
  type ViewResult,
  type Worktree,
} from "./api";
import { showBranchSwitcher } from "./branch-switcher";
import { openMergeTool } from "./merge-view";
import { openLocalHistory } from "./local-history-view";
import { isMac, Keymap, type KeyAction } from "./keymap";
import { openSettingsDialog } from "./settings-dialog";
import { openHistory } from "./history-view";
import { confirmDialog, conflictsDialog, credentialDialog, formDialog, interactiveRebaseDialog, messageDialog, pushDialog, resetDialog, updateDialog } from "./dialogs";
import { toast } from "./notify";
import { OpBanner } from "./op-banner";
import { CommitPanel, type LocalFile } from "./commit-panel";
import { StashPanel } from "./stash-panel";
import { ChangesPanel } from "./changes-panel";
import { menuBelow, showMenu, type MenuItem } from "./context-menu";
import { DetailsPanel } from "./details-panel";
import { applyDiffSettings, DiffView, setMonacoTheme } from "./diff-view";
import { copyText, dragResize, h } from "./dom";
import { FilterBar, emptyFilter } from "./filter-bar";
import { LogView } from "./log-view";
import { addRecent, removeRecent, save, settings } from "./settings";
import { Sidebar } from "./sidebar";

const mod = navigator.platform.includes("Mac") ? "⌘" : "Ctrl+";

// ---- components ----

const log = new LogView();
const sidebar = new Sidebar();
const filterBar = new FilterBar();
const changes = new ChangesPanel();
const details = new DetailsPanel();
const diff = new DiffView();
const commitPanel = new CommitPanel();
const stashPanel = new StashPanel();

let view: ViewResult | null = null;
let refs: BranchInfo[] = [];
let recent: RecentBranch[] = [];
let worktrees: Worktree[] = [];
let repoState: RepoState | null = null;
const banner = new OpBanner();
let selected: Row[] = [];
const authors = new Set<string>();

// ---- layout ----

const openBtn = h("button", { class: "tb-button", title: `Open a repository (${mod}O)` }, "📂 Open ▾");
const refreshBtn = h("button", { class: "tb-button", title: `Reload commits and branches (${mod}R)`, disabled: true }, "⟳ Refresh");
const fetchBtn = h("button", { class: "tb-button", title: "Fetch all remotes", disabled: true }, "⇣ Fetch");
const updateBtn = h("button", { class: "tb-button", title: `Update the current branch: fetch, then merge or rebase (${mod}T)`, disabled: true }, "↧ Update");
const pushBtn = h("button", { class: "tb-button", title: `Push the current branch (${mod}⇧K)`, disabled: true }, "↥ Push");
const localHistoryBtn = h("button", { class: "tb-button", title: "Local History: the recent versions of changed files", disabled: true }, "🕘 Local History");
const repoLabel = h("span", { class: "tb-repo" });
const branchBtn = h("button", { class: "tb-button tb-branch-button", title: "Switch branch (recent branches first)", hidden: true }, "⑂ ▾");
const viewBtn = h("button", { class: "tb-button", title: "View options" }, "View ▾");
const themeBtn = h("button", { class: "tb-button", title: "Theme" }, "◐");
const settingsBtn = h("button", { class: "tb-button", title: "Settings" }, "⚙");
settingsBtn.addEventListener("click", () => void openSettings());
const toolbar = h("header", { class: "toolbar" }, openBtn, refreshBtn, fetchBtn, updateBtn, pushBtn, localHistoryBtn, repoLabel, branchBtn, h("span", { class: "spacer" }), viewBtn, themeBtn, settingsBtn);

const tabBar = h("nav", { class: "tabbar", hidden: true });

const statusLeft = h("span", { class: "sb-left" });
const statusMid = h("span", { class: "sb-mid" });
const statusRight = h("span", { class: "sb-right" });
const statusBar = h("footer", { class: "statusbar" }, statusLeft, statusMid, statusRight);

const sideGrip = h("div", { class: "vgrip" });
const rightGrip = h("div", { class: "vgrip" });
const diffGrip = h("div", { class: "hgrip-row" });
const detailsGrip = h("div", { class: "hgrip-row" });
const center = h("section", { class: "center" }, banner.el, filterBar.el, log.el);
const right = h("section", { class: "right" }, changes.el, detailsGrip, details.el);
const tabBranches = h("button", { class: "lp-tab", title: `Branches (${mod}1)` }, "Branches");
const tabCommit = h("button", { class: "lp-tab", title: `Commit (${mod}K)` }, "Commit");
const tabStash = h("button", { class: "lp-tab", title: "Stashes" }, "Stash");
const leftPane = h("aside", { class: "leftpane" }, h("div", { class: "lp-tabs" }, tabBranches, tabCommit, tabStash), sidebar.el, commitPanel.el, stashPanel.el);
function showLeftTab(tab: "branches" | "commit" | "stash") {
  settings.leftTab = tab;
  save();
  if (!settings.showSidebar) {
    settings.showSidebar = true;
    applyLayout();
  }
  tabBranches.classList.toggle("on", tab === "branches");
  tabCommit.classList.toggle("on", tab === "commit");
  tabStash.classList.toggle("on", tab === "stash");
  sidebar.el.hidden = tab !== "branches";
  commitPanel.el.hidden = tab !== "commit";
  stashPanel.el.hidden = tab !== "stash";
}
tabBranches.addEventListener("click", () => showLeftTab("branches"));
tabCommit.addEventListener("click", () => showLeftTab("commit"));
tabStash.addEventListener("click", () => showLeftTab("stash"));
const top = h("div", { class: "top" }, leftPane, sideGrip, center, rightGrip, right);
const workspace = h("main", { class: "workspace" }, top, diffGrip, diff.el);
const welcome = h("main", { class: "welcome" });
const app = document.getElementById("app")!;
app.append(toolbar, tabBar, welcome, workspace, statusBar);

function applyLayout() {
  top.style.gridTemplateColumns = `${settings.showSidebar ? `${settings.sidebarWidth}px 4px` : "0 0"} minmax(300px, 1fr) 4px ${settings.rightWidth}px`;
  leftPane.hidden = !settings.showSidebar;
  sideGrip.hidden = !settings.showSidebar;
  workspace.style.gridTemplateRows = `${1 - settings.diffRatio}fr 5px ${settings.diffRatio}fr`;
  right.style.gridTemplateRows = `${settings.detailsRatio}fr 5px ${1 - settings.detailsRatio}fr`;
}

{
  let start = 0;
  dragResize(sideGrip, "x", () => (start = settings.sidebarWidth), (d) => {
    settings.sidebarWidth = Math.max(160, Math.min(520, start + d));
    applyLayout();
  }, save);
  dragResize(rightGrip, "x", () => (start = settings.rightWidth), (d) => {
    settings.rightWidth = Math.max(240, Math.min(760, start - d));
    applyLayout();
  }, save);
  dragResize(diffGrip, "y", () => (start = settings.diffRatio), (d) => {
    settings.diffRatio = Math.max(0.12, Math.min(0.85, start - d / workspace.clientHeight));
    applyLayout();
  }, save);
  dragResize(detailsGrip, "y", () => (start = settings.detailsRatio), (d) => {
    settings.detailsRatio = Math.max(0.15, Math.min(0.85, start + d / right.clientHeight));
    applyLayout();
  }, save);
}

// ---- theme ----

const darkQuery = matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  const dark = settings.theme === "dark" || (settings.theme === "system" && darkQuery.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  setMonacoTheme(dark);
  log.render();
}
darkQuery.addEventListener("change", applyTheme);
themeBtn.addEventListener("click", () =>
  menuBelow(themeBtn, (["system", "light", "dark"] as const).map((t) => ({
    label: { system: "Follow system", light: "Light", dark: "Dark" }[t],
    checked: settings.theme === t,
    action: () => {
      settings.theme = t;
      save();
      applyTheme();
    },
  }))),
);

// ---- status ----

let busy = 0;
async function task<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  busy++;
  statusRight.textContent = label + "…";
  statusRight.className = "sb-right busy";
  try {
    const r = await fn();
    statusRight.textContent = "";
    statusRight.className = "sb-right";
    return r;
  } catch (e) {
    statusRight.textContent = String(e).replace(/^Error: /, "");
    statusRight.className = "sb-right error";
    return undefined;
  } finally {
    busy--;
  }
}

function updateStatus() {
  if (!view) return;
  const branch = repoState?.rebasing
    ? `rebasing ${repoState.rebasing}`
    : (view.head?.replace("refs/heads/", "") ?? (view.headOid ? `detached at ${view.headOid.slice(0, 8)}` : "no commits"));
  repoLabel.replaceChildren(h("b", {}, view.root.split(/[\\/]/).pop() ?? view.root));
  branchBtn.hidden = false;
  branchBtn.textContent = `⑂ ${branch} ▾`;
  const changed = repoState?.changedFiles ?? 0;
  statusLeft.textContent = view.root + (changed ? `  ·  ${changed} changed file${changed === 1 ? "" : "s"}` : "");
  statusMid.textContent = view.filtered
    ? `${view.rowCount.toLocaleString()} of ${view.totalCommits.toLocaleString()} commits match the filter`
    : `${view.totalCommits.toLocaleString()} commits`;
  if (view.collapsed) statusMid.textContent += ` · ${view.rowCount.toLocaleString()} rows shown, linear branches collapsed`;
  filterBar.setInfo(view.filtered ? `${view.rowCount.toLocaleString()} of ${view.totalCommits.toLocaleString()}` : "");
  if (!busy) statusRight.textContent = `loaded in ${view.loadMs} ms`;
}

// ---- repository ----

function viewSettings() {
  return { intelliSort: settings.intelliSort, showLongEdges: settings.showLongEdges, collapseLinear: settings.collapseLinear, filter: filterBar.filter };
}

// ---- tabs: several repositories ----

/** What a tab keeps while another tab is active. */
interface TabState {
  filter: LogFilter;
  selected: string | null;
}
const tabStates = new Map<string, TabState>();

function renderTabs() {
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
  if (!settings.activeTab || !view) return;
  tabStates.set(settings.activeTab, { filter: filterBar.filter, selected: selected[0]?.oid ?? null });
}

/** Opens a repository in a new tab, or shows its tab when it is open already. */
async function openRepo(path: string) {
  const known = settings.tabs.find((t) => t === path);
  if (known && known === settings.activeTab && view) return;
  saveTabState();
  const r = await task("Opening repository", () => api.open(path, { ...viewSettings(), filter: emptyFilter() }));
  if (!r) return;
  if (!settings.tabs.includes(r.root)) settings.tabs.push(r.root);
  tabStates.delete(r.root);
  await showRepo(r, null);
}

async function switchTab(root: string) {
  saveTabState();
  const state = tabStates.get(root) ?? null;
  const r = await task("Switching repository", () => api.activate(root, { ...viewSettings(), filter: state?.filter ?? emptyFilter() }));
  if (!r) return;
  await showRepo(r, state);
}

async function closeTab(root: string) {
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
  save();
  const next = settings.tabs[Math.min(i, settings.tabs.length - 1)];
  if (next) await switchTab(next);
  else {
    view = null;
    commitPanel.clear();
    document.title = "Rebased Lite";
    refreshBtn.disabled = fetchBtn.disabled = updateBtn.disabled = pushBtn.disabled = localHistoryBtn.disabled = true;
    renderTabs();
    showWorkspace(false);
  }
}

/** Shows the repository of the active tab. `state` restores the filter and the selection of a tab. */
async function showRepo(r: ViewResult, state: TabState | null) {
  settings.activeTab = r.root;
  save();
  renderTabs();
  filterBar.set(state?.filter ?? emptyFilter(), false);
  addRecent(r.root);
  authors.clear();
  watchSeen = null;
  lastUndo = null;
  commitPanel.clear();
  showWorkspace(true);
  await applyView(r, false);
  await loadRefs();
  const target = state?.selected ?? r.headOid;
  if (target) void jumpToOid(target, true);
}

async function applyView(r: ViewResult, keepSelection: boolean) {
  const keepOids = keepSelection ? selected.map((s) => s.oid) : [];
  view = r;
  document.title = `${r.root.split(/[\\/]/).pop()} – Rebased Lite`;
  refreshBtn.disabled = fetchBtn.disabled = updateBtn.disabled = pushBtn.disabled = localHistoryBtn.disabled = false;
  updateStatus();
  log.setCollapsed(r.collapsed);
  log.reset(r.rowCount, r.recommendedWidth);
  selected = [];
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

async function loadRefs() {
  const [r, rec, wt, st, subs] = await Promise.all([
    api.refs().catch(() => [] as BranchInfo[]),
    api.recentBranches().catch(() => [] as RecentBranch[]),
    api.worktrees().catch(() => [] as Worktree[]),
    api.repoState().catch(() => null),
    api.submodules().catch(() => [] as Submodule[]),
  ]);
  try {
    refs = r;
    recent = rec;
    worktrees = wt;
    repoState = st;
    sidebar.setRefs(refs);
    sidebar.setRecent(recent);
    sidebar.setWorktrees(worktrees);
    sidebar.setSubmodules(subs);
    banner.update(repoState);
    filterBar.branchNames = refs.filter((b) => b.kind !== "tag").map((b) => b.name);
    updateStatus();
  } catch (e) {
    // The local changes still load.
    console.error("Loading the branches failed", e);
  }
  await loadLocalChanges();
}

async function loadLocalChanges() {
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
  tabCommit.replaceChildren("Commit", n ? h("span", { class: "lp-count" }, String(n)) : "");
  try {
    stashPanel.set(await api.stashes());
  } catch {
    stashPanel.set([]);
  }
  tabStash.replaceChildren("Stash", stashPanel.count ? h("span", { class: "lp-count" }, String(stashPanel.count)) : "");
}

// ---- credential prompts ----

// While an operation runs, git can ask for a password through the askpass program of the app.
const askpassShown = new Set<number>();
let askpassBusy = false;
async function pollAskpass() {
  if (busy === 0 || askpassBusy) return;
  const prompts = await api.askpassPending().catch(() => []);
  const next = prompts.find((p) => !askpassShown.has(p.id));
  if (!next) return;
  askpassShown.add(next.id);
  askpassBusy = true;
  try {
    const r = await credentialDialog(next);
    await api.askpassAnswer(next.id, r?.answer ?? null, r?.remember ?? false);
  } finally {
    askpassBusy = false;
  }
}
setInterval(() => void pollAskpass(), 300);

// ---- auto refresh ----

/** The watcher counters that the view shows; changes after a write operation of the app are expected. */
let watchSeen: { repo: number; files: number } | null = null;
let watchQuietUntil = 0;

async function pollWatch() {
  if (!view || busy > 0 || document.hidden || !settings.autoRefresh) return;
  const c = await api.watchState().catch(() => null);
  if (!c) return;
  const before = watchSeen;
  watchSeen = c;
  if (!before || Date.now() < watchQuietUntil || busy > 0) return;
  if (c.repo !== before.repo) {
    const r = await api.refresh().catch(() => null);
    if (r) {
      await applyView(r, true);
      await loadRefs();
    }
  } else if (c.files !== before.files) {
    repoState = await api.repoState().catch(() => repoState);
    banner.update(repoState);
    updateStatus();
    await loadLocalChanges();
    const f = commitPanel.activeFile();
    if (diffSource === "local" && f) void showLocalDiff(f);
  }
}
setInterval(() => void pollWatch(), 1000);

// Files change outside the app; reload the local changes when the window gets the focus.
let focusTimer = 0;
window.addEventListener("focus", () => {
  if (!view || Date.now() - focusTimer < 1500) return;
  focusTimer = Date.now();
  void api.repoState().then((st) => {
    repoState = st;
    banner.update(st);
    updateStatus();
  }).catch(() => {});
  void loadLocalChanges();
});

async function reloadView() {
  const r = await task("Updating the log", () => api.setView(viewSettings()));
  if (r) await applyView(r, true);
  sidebar.setFilter(filterBar.filter.branches);
}

async function refresh() {
  if (!view) return;
  const r = await task("Refreshing", () => api.refresh());
  if (r) {
    await applyView(r, true);
    await loadRefs();
  }
}

async function fetchAll() {
  if (!view) return;
  const r = await task("Fetching all remotes", () => api.fetch());
  if (r) {
    await applyView(r, true);
    await loadRefs();
    statusRight.textContent = "Fetch finished";
  }
}

async function jumpToOid(oid: string, select: boolean): Promise<boolean> {
  const f = await api.find(oid);
  if (f.row === null) {
    if (f.oid) statusRight.textContent = `Commit ${f.oid.slice(0, 8)} is hidden by the current filter.`;
    return false;
  }
  if (f.rowCount !== null && view) {
    // Finding the commit expanded a collapsed branch.
    view = { ...view, rowCount: f.rowCount };
    log.reset(f.rowCount, view.recommendedWidth, true);
    updateStatus();
  }
  log.jumpTo(f.row, select);
  return true;
}

filterBar.onChange = () => void reloadView();
filterBar.onJump = (q) => jumpToOid(q, true);
log.onRowsLoaded = (rows) => {
  const before = authors.size;
  for (const r of rows) if (r.author) authors.add(r.author);
  if (authors.size !== before) filterBar.setAuthors([...authors].sort());
};

// ---- compare ----

let left: RevSpec = "worktree";
let rightRev: RevSpec = "worktree";
let changeList: Change[] = [];
let active = -1;
let request = 0;
/** Which panel the diff shows a file of: the changes of the selected commits, or the local changes. */
let diffSource: "log" | "local" = "log";

function clearCompare() {
  request++;
  changeList = [];
  changes.setTitle("Changes");
  changes.setMessage("Select a commit to see its changes.");
  details.clear();
  diff.message("Select a commit to see its changes.");
}

function short(oid: string) {
  return oid.slice(0, 8);
}

async function compare(l: RevSpec, r: RevSpec, title: string, leftLabel: string, rightLabel: string) {
  const req = ++request;
  left = l;
  rightRev = r;
  active = -1;
  changes.setTitle(title);
  changes.setMessage("Loading…");
  diff.message("Loading…");
  diff.setSides(leftLabel, rightLabel);
  try {
    const res = await api.compare(l, r);
    if (req !== request) return;
    changeList = res.changes;
    changes.setChanges(changeList);
    if (changeList.length) void openFile(changes.firstInOrder());
    else diff.message("There are no changes.");
  } catch (e) {
    if (req === request) {
      changes.setMessage(String(e));
      diff.message("");
    }
  }
}

async function openFile(i: number) {
  if (i < 0 || i >= changeList.length) return;
  const req = request;
  active = i;
  changes.setActive(i);
  const c = changeList[i];
  try {
    const r = c.rightRev ?? rightRev;
    const pair = await api.filePair(left, r, c.path, c.old_path);
    if (req !== request || active !== i) return;
    diff.setSource(c.status === "D" ? { path: c.old_path ?? c.path, rev: left } : { path: c.path, rev: r });
    diff.setSelectable(null);
    diff.setListHunks([]);
    diff.setMoveChange(null);
    diff.show(c, pair.left, pair.right);
  } catch (e) {
    if (req === request) diff.message(String(e));
  }
}

function showSelection(rows: Row[]) {
  selected = rows;
  stashPanel.clearSelection();
  diffSource = "log";
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

function compareWithWorktree(r: Row) {
  void compare({ commit: r.oid }, "worktree", `${short(r.oid)} → working tree`, short(r.oid), "working tree");
}

log.onSelectionChange = showSelection;
changes.onOpen = (i) => void openFile(i);
changes.onSwap = () => {
  if (rightRev === "worktree" || left === "worktree") return;
  const [l, r] = [left, rightRev];
  const label = (s: RevSpec) => (typeof s === "object" && "commit" in s ? short(s.commit) : "parent");
  void compare(r, l, `${label(r)} → ${label(l)}`, label(r), label(l));
};
diff.onNextFile = () => (diffSource === "local" ? commitPanel.move(1) : changes.move(1));
diff.onPrevFile = () => (diffSource === "local" ? commitPanel.move(-1) : changes.move(-1));
details.onJump = (oid) => void jumpToOid(oid, true);

// ---- collapse ----

async function collapse(mode: "all" | "none" | "row" | "edge", row?: number, up?: number, down?: number) {
  const keep = selected.map((s) => s.oid);
  const r = await task(mode === "all" ? "Collapsing linear branches" : "Updating the graph", () => api.collapse(mode, row, up, down));
  if (!r) return;
  if (mode === "all" || mode === "none") {
    settings.collapseLinear = mode === "all";
    save();
  }
  view = r;
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

// ---- write operations ----

/** Runs a write operation, reloads the log, and reports the result. */
async function runOp(op: Op, label: string, errorAction?: { label: string; run: () => void }): Promise<OpOutcome | undefined> {
  const outcome = await task(label, () => api.runOp(op));
  // The watcher reports the changes of this operation; the view reloads below anyway.
  watchQuietUntil = Date.now() + 1500;
  if (!outcome) return undefined;
  await applyView(outcome.view, true);
  await loadRefs();
  const r = outcome.result;
  if (r.ok) {
    lastUndo = r.undo.length ? { actions: r.undo, message: r.message } : null;
    toast(r.message, "success", r.undo.length ? { label: "Undo", run: () => void undoLast() } : undefined);
    const stale = outcome.staleSubmodules;
    if (stale.length) {
      const what = stale.length === 1 ? `Submodule ${stale[0]} is` : `${stale.length} submodules are`;
      toast(`${what} not at the commit that this revision records.`, "info", { label: "Update Submodules", run: () => updateSubmodules(stale) });
    }
    statusRight.textContent = r.message;
  } else {
    toast(r.message, "error", errorAction);
    statusRight.textContent = r.message;
    statusRight.className = "sb-right error";
  }
  return outcome;
}

/** The undo steps of the last operation, for the toast and for Ctrl+Z. */
let lastUndo: { actions: UndoAction[]; message: string } | null = null;

async function undoLast() {
  const u = lastUndo;
  if (!u) {
    statusRight.textContent = "There is nothing to undo";
    return;
  }
  lastUndo = null;
  await runOp({ op: "undo", actions: u.actions }, `Undoing: ${u.message}`);
}

const currentBranch = () => repoState?.branch ?? view?.head?.replace("refs/heads/", "") ?? null;

async function checkoutBranch(b: BranchInfo) {
  if (b.kind === "tag") return checkoutCommit(b.oid, b.name);
  await runOp({ op: "checkout", target: b.name, kind: b.kind }, `Checking out ${b.name}`);
}

async function checkoutCommit(oid: string, label = short(oid)) {
  if (!(await confirmDialog("Check out a commit", `HEAD will point to ${label} directly (detached HEAD). New commits will not be on a branch until you create one.`, "Check Out"))) return;
  await runOp({ op: "checkout", target: oid, kind: "commit" }, `Checking out ${label}`);
}

async function newBranch(at: string, atLabel: string) {
  const r = await formDialog(`New branch from ${atLabel}`, [
    { key: "name", label: "Branch name", placeholder: "feature/my-change" },
    { key: "checkout", label: "Check out the new branch", type: "checkbox", value: true },
  ], "Create");
  if (!r || !String(r.name).trim()) return;
  await runOp({ op: "createBranch", name: String(r.name).trim(), at, checkout: !!r.checkout }, "Creating branch");
}

async function newTag(at: string, atLabel: string) {
  const r = await formDialog(`New tag on ${atLabel}`, [
    { key: "name", label: "Tag name", placeholder: "v1.0.0" },
    { key: "message", label: "Message (optional; makes an annotated tag)", type: "textarea" },
  ], "Create");
  if (!r || !String(r.name).trim()) return;
  await runOp({ op: "createTag", name: String(r.name).trim(), at, message: String(r.message) }, "Creating tag");
}

async function mergeIntoCurrent(rev: string, label: string) {
  const cur = currentBranch();
  if (!cur) return toast("HEAD is detached. Check out a branch first.", "error");
  await runOp({ op: "merge", rev }, `Merging ${label} into ${cur}`);
}

async function rebaseCurrentOnto(rev: string, label: string) {
  const cur = currentBranch();
  if (!cur) return toast("HEAD is detached. Check out a branch first.", "error");
  if (!(await confirmDialog("Rebase", `Rebase ${cur} onto ${label}? The commits of ${cur} get new hashes.`, "Rebase"))) return;
  await runOp({ op: "rebase", onto: rev }, `Rebasing ${cur} onto ${label}`);
}

async function resetTo(oid: string) {
  const cur = currentBranch() ?? "HEAD";
  const mode = await resetDialog(short(oid), cur);
  if (!mode) return;
  if (mode === "hard" && !(await confirmDialog("Hard reset", "All uncommitted changes in the working tree will be lost. Continue?", "Reset Hard", true))) return;
  await runOp({ op: "reset", to: oid, mode }, `Resetting ${cur}`);
}

/** Selected rows are sorted top to bottom (newest first). */
async function rewriteSelected(kind: "squash" | "drop" | "reword", rows: Row[]) {
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

async function interactiveRebase(from: Row) {
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

async function deleteBranch(b: BranchInfo) {
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

async function renameBranch(b: BranchInfo) {
  const r = await formDialog(`Rename ${b.name}`, [{ key: "name", label: "New name", value: b.name }], "Rename");
  if (!r || !String(r.name).trim() || r.name === b.name) return;
  await runOp({ op: "renameBranch", from: b.name, to: String(r.name).trim() }, "Renaming branch");
}

async function addWorktree(at = "HEAD", atLabel = "HEAD") {
  const root = view?.root ?? "";
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
  if (await confirmDialog("Abort", `Abort the ${repoState?.operation}? The branch returns to where it was before.`, "Abort", true)) {
    await runOp({ op: "abort" }, "Aborting");
  }
};
banner.onMarkResolved = (paths) => void runOp({ op: "markResolved", paths }, "Marking resolved");
banner.onShowFile = (path) => void mergeFile(path);

sidebar.onCheckout = (b) => void checkoutBranch(b);
sidebar.onAddWorktree = () => void addWorktree();
sidebar.onOpenWorktree = (w) => void openRepo(w.path);
const updateSubmodules = (paths: string[]) => void runOp({ op: "updateSubmodules", paths }, "Updating submodules");
const submodulePath = (s: Submodule) => `${view?.root ?? ""}/${s.path}`;
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
  showBranchSwitcher(branchBtn, refs, recent, {
    checkout: (b) => void checkoutBranch(b),
    newBranch: () => void newBranch("HEAD", currentBranch() ?? "HEAD"),
    menu: (b, e) => sidebar.onContextMenu(b, e),
  }),
);

// ---- local changes and commit ----

let localRequest = 0;
async function showLocalDiff(f: LocalFile) {
  const req = ++localRequest;
  request++;
  diffSource = "local";
  const head = commitPanel.head;
  const status = f.change.status === "?" ? "A" : f.change.status === "U" ? "M" : f.change.status;
  const change = { ...f.change, status };
  diff.setSides(head ? "HEAD" : "empty", "working tree");
  try {
    const pair = head
      ? await api.filePair({ commit: head }, "worktree", change.path, change.old_path)
      : { left: { text: null, binary: false, size: 0, missing: true }, right: (await api.filePair("worktree", "worktree", change.path, null)).right };
    if (req !== localRequest || diffSource !== "local") return;
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

async function changeListOp(op: Parameters<typeof api.changeListOp>[0]) {
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

async function newChangeList(paths: string[] = []) {
  const r = await formDialog("New Changelist", [
    { key: "name", label: "Name", placeholder: "Feature work" },
    { key: "comment", label: "Comment (the draft commit message)", type: "textarea" },
    { key: "active", label: "Set active", type: "checkbox", value: paths.length === 0 },
  ], "Create", paths.length ? `${paths.length} file(s) move to the new changelist.` : "New changes go to the active changelist.");
  if (!r || !String(r.name).trim()) return;
  await changeListOp({ op: "create", name: String(r.name), comment: String(r.comment), makeActive: !!r.active, paths });
}

async function editChangeList(l: ChangeListView) {
  const r = await formDialog(`Edit Changelist ${l.name}`, [
    { key: "name", label: "Name", value: l.name },
    { key: "comment", label: "Comment (the draft commit message)", type: "textarea", value: l.comment },
  ], "Save");
  if (!r || !String(r.name).trim()) return;
  await changeListOp({ op: "edit", id: l.id, name: String(r.name), comment: String(r.comment) });
}

async function removeChangeList(l: ChangeListView) {
  if (commitPanel.lists.length === 1) return toast("The last changelist cannot be removed.", "error");
  const to = commitPanel.lists.find((x) => x.active && x.id !== l.id)?.name ?? commitPanel.lists.find((x) => x.id !== l.id)?.name;
  if (l.changes.length && !(await confirmDialog("Remove changelist", `Remove ${l.name}? Its ${l.changes.length} file(s) move to ${to}. The changes stay.`, "Remove"))) return;
  await changeListOp({ op: "remove", id: l.id });
}

async function rollback(files: LocalFile[]) {
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

async function deleteUnversioned(files: LocalFile[]) {
  const paths = files.filter((f) => f.list === null).map((f) => f.change.path);
  if (!paths.length) return;
  if (!(await confirmDialog("Delete files", `Delete ${paths.length} unversioned file(s) from the disk? This cannot be undone.`, "Delete", true))) return;
  await runOp({ op: "deleteUnversioned", paths }, "Deleting files");
}

async function commitFiles(files: LocalFile[], message: string, amend: boolean, list: string | null, push = false) {
  if (!message.trim()) {
    toast("Enter a commit message.", "error");
    commitPanel.focusMessage();
    return;
  }
  const conflicts = files.filter((f) => f.change.status === "U");
  if (conflicts.length && !(await confirmDialog("Conflicts", `${conflicts.length} file(s) had conflicts. Commit them as they are in the working tree?`, "Commit"))) return;
  if (amend && view?.headOid) {
    const published = refs.some((b) => b.kind === "remote" && b.oid === view!.headOid);
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
  if ((partial.length || hunks.length) && repoState?.operation === "merge") return toast("A merge is in progress: commit whole files to finish it.", "error");
  const out = await runOp({ op: "commit", paths, unversioned, partial, hunks, message, amend }, amend ? "Amending" : "Committing");
  if (out?.result.ok) {
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
commitPanel.onCommit = (files, message, amend, list, push) => void commitFiles(files, message, amend, list, push);

// ---- push and update ----

async function pushBranch(branch?: string) {
  let info;
  try {
    info = await api.pushInfo(branch);
  } catch (e) {
    return toast(String(e).replace(/^Error: /, ""), "error");
  }
  if (!info.remote) return toast("The repository has no remote.", "error");
  if (!info.outgoing.length && !info.newBranch) return toast(`Nothing to push: ${info.branch} is up to date with ${info.upstream}.`, "info");
  const choice = await pushDialog(info);
  if (!choice) return;
  if (choice.force && !(await confirmDialog("Force push", `Force push ${info.branch} to ${choice.remote}/${choice.remoteBranch}? Commits on the remote branch that are not in ${info.branch} are removed from it.`, "Force Push", true))) return;
  const branchName = info.branch;
  const retry =
    branchName === currentBranch() ? { label: "Update", run: () => void updateBranch().then((ok) => ok && void pushBranch(branchName)) } : undefined;
  await runOp({ op: "push", branch: branchName, ...choice }, `Pushing ${branchName}`, retry);
}

/** Returns true when the update finished without a conflict. */
async function updateBranch(): Promise<boolean> {
  const branch = currentBranch();
  if (!branch) {
    toast("HEAD is detached. Check out a branch first.", "error");
    return false;
  }
  const upstream = refs.find((b) => b.kind === "local" && b.name === branch)?.upstream ?? null;
  if (!upstream) {
    toast(`${branch} has no tracked branch. Push it with a tracked branch first.`, "error");
    return false;
  }
  const mode = await updateDialog(branch, upstream, settings.updateMode);
  if (!mode) return false;
  settings.updateMode = mode;
  save();
  const out = await runOp({ op: "update", mode }, `Updating ${branch}`);
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
    { label: "Show History", disabled: files.length !== 1 || files[0].list === null || files[0].change.status === "A", action: () => showHistory(files[0].change.old_path ?? files[0].change.path) },
    { label: "Show Local History", disabled: files.length !== 1, action: () => showLocalHistory(files[0].change.path) },
    { label: "Rollback…", shortcut: `${mod}⌥Z`, disabled: !tracked.length, action: () => void rollback(tracked) },
  ];
  if (untracked.length) {
    items.push(
      { label: "Add to Git", action: () => void runOp({ op: "addFiles", paths: untracked.map((f) => f.change.path) }, "Adding files") },
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

// ---- stashes ----

async function showStash(s: Stash) {
  const req = ++request;
  diffSource = "log";
  commitPanel.setActiveFile(null);
  changes.setTitle(`stash@{${s.index}}: ${s.message}`);
  changes.setMessage("Loading…");
  diff.message("Loading…");
  details.clear();
  try {
    const d = await api.stashDetail(s.index);
    if (req !== request) return;
    left = { commit: d.base };
    rightRev = { commit: d.oid };
    active = -1;
    diff.setSides(short(d.base), `stash@{${s.index}}`);
    const untrackedRev: RevSpec | undefined = d.untrackedOid ? { commit: d.untrackedOid } : undefined;
    changeList = [...d.changes, ...d.untracked.map((p) => ({ status: "A", path: p, old_path: null, rightRev: untrackedRev }))];
    changes.setChanges(changeList);
    if (changeList.length) void openFile(changes.firstInOrder());
    else diff.message("The stash has no changes.");
  } catch (e) {
    if (req === request) {
      changes.setMessage(String(e));
      diff.message("");
    }
  }
}

async function stashChanges(paths: string[], hasUntracked: boolean, suggested: string) {
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

// ---- file history ----

function showHistory(path: string) {
  void openHistory(path, {
    load: api.fileHistory,
    pair: api.filePair,
    blame: api.blame,
    showInLog: (oid) => void jumpToOid(oid, true),
  });
}

function showLocalHistory(path: string) {
  void openLocalHistory(path, {
    load: api.localHistory,
    content: api.localHistoryContent,
    current: async (p) => (await api.filePair("worktree", "worktree", p, null)).right,
    revert: async (r) => {
      const what = r.blob ? `Write the version of ${formatLocalTime(r.time)} back to ${r.path}?` : `Delete ${r.path}? It did not exist at ${formatLocalTime(r.time)}.`;
      if (!(await confirmDialog("Revert to a Local History version", `${what} Local History keeps the current content first.`, "Revert"))) return false;
      const out = await runOp({ op: "revertLocalHistory", path: r.path, blob: r.blob }, `Reverting ${r.path}`);
      if (out?.result.ok) void loadLocalChanges();
      return !!out?.result.ok;
    },
  });
}
const formatLocalTime = (ms: number) => new Date(ms).toLocaleString();
localHistoryBtn.addEventListener("click", () => showLocalHistory(""));

diff.onBlame = api.blame;
diff.onBlameClick = (oid) => void jumpToOid(oid, true);
diff.onHistory = showHistory;

// ---- conflicts ----

/** Opens the merge window for one file. Returns true when the file was resolved. */
async function mergeFile(path: string): Promise<boolean> {
  let sides;
  try {
    sides = await api.mergeSides(path);
  } catch (e) {
    toast(String(e).replace(/^Error: /, ""), "error");
    return false;
  }
  if (sides.binary || sides.ours.text === null || sides.theirs.text === null) {
    const why = sides.binary ? "is binary" : sides.ours.text === null ? "was deleted in yours" : "was deleted in theirs";
    const r = await conflictsDialog([path], sides.ours.label, sides.theirs.label);
    if (!r || r.action === "merge") {
      if (r) toast(`${path} ${why}. Take one whole side.`, "info");
      return false;
    }
    return !!(await runOp({ op: "resolveSide", paths: [path], side: r.action }, "Resolving"))?.result.ok;
  }
  const outcome = await openMergeTool({
    path,
    base: sides.base.text,
    ours: sides.ours.text,
    theirs: sides.theirs.text,
    oursLabel: sides.ours.label,
    theirsLabel: sides.theirs.label,
  });
  if (outcome.kind === "cancel") return false;
  const op: Op = outcome.kind === "save" ? { op: "resolveText", path, text: outcome.text } : { op: "resolveSide", paths: [path], side: outcome.side };
  return !!(await runOp(op, "Resolving"))?.result.ok;
}

/** The Conflicts dialog: repeats until no conflict is left or the user closes it. */
async function resolveConflicts() {
  for (;;) {
    const st = await api.repoState().catch(() => null);
    if (!st?.conflicts.length) return;
    const labels = await api.mergeSides(st.conflicts[0]).then((s) => [s.ours.label, s.theirs.label]).catch(() => ["yours", "theirs"]);
    const r = await conflictsDialog(st.conflicts, labels[0], labels[1]);
    if (!r) return;
    if (r.action === "merge") {
      await mergeFile(r.paths[0]);
    } else {
      await runOp({ op: "resolveSide", paths: r.paths, side: r.action }, "Resolving");
    }
  }
}

banner.onResolve = () => void resolveConflicts();

// ---- menus ----

async function rowMenu(r: Row, e: MouseEvent) {
  const selected = await log.selectedRows();
  if (!selected.length) selected.push(r);
  const multi = selected.length > 1;
  const cur = currentBranch();
  const items: MenuItem[] = [
    { label: multi ? "Copy Revision Numbers" : "Copy Revision Number", shortcut: keymap.shortcut("copyHash"), action: () => void copyText(multi ? selected.map((s) => s.oid).join(" ") : r.oid) },
    { label: "Copy Subject", action: () => void copyText(r.subject) },
    { separator: true },
    { label: "Compare with Parent", action: () => log.select([r.row]) },
    { label: "Compare with Working Tree", action: () => compareWithWorktree(r) },
  ];
  if (selected.length === 2) items.push({ label: "Compare Selected Commits", action: () => showSelection(selected) });
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
    { label: multi ? `Cherry-Pick ${selected.length} Commits` : "Cherry-Pick", action: () => void runOp({ op: "cherryPick", oids: [...selected].reverse().map((s) => s.oid) }, "Cherry-picking") },
    { label: multi ? `Revert ${selected.length} Commits` : "Revert Commit", action: () => void runOp({ op: "revert", oids: selected.map((s) => s.oid) }, "Reverting") },
    { label: "Edit Commit Message…", disabled: multi, action: () => void rewriteSelected("reword", [r]) },
    { label: multi ? `Squash ${selected.length} Commits…` : "Squash Commits… (select 2 or more)", disabled: !multi, action: () => void rewriteSelected("squash", selected) },
    { label: multi ? `Drop ${selected.length} Commits…` : "Drop Commit…", action: () => void rewriteSelected("drop", selected.length ? selected : [r]) },
    { label: "Interactively Rebase from Here…", disabled: multi, action: () => void interactiveRebase(r) },
  );
  items.push({ separator: true }, { header: "Graph" });
  items.push(
    { label: "Collapse Linear Branch Here", action: () => void collapse("row", r.row) },
    { label: "Collapse All Linear Branches", action: () => void collapse("all") },
    { label: "Expand All Linear Branches", disabled: !view?.collapsed, action: () => void collapse("none") },
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

sidebar.onNavigate = (b) => void jumpToOid(b.oid, true);
sidebar.onToggleFilter = (b) => filterBar.toggleBranch(b.name);
sidebar.onContextMenu = (b, e) => {
  const current = refs.find((x) => x.current);
  const cur = currentBranch();
  const isCurrent = b.current;
  showMenu(e.clientX, e.clientY, [
    { label: b.kind === "remote" ? "Check Out as Local Branch" : "Check Out", disabled: isCurrent, action: () => void checkoutBranch(b) },
    { label: "New Branch from Here…", action: () => void newBranch(b.oid, b.name) },
    { label: "New Worktree…", action: () => void addWorktree(b.kind === "local" ? b.name : b.oid, b.name) },
    { separator: true },
    { label: "Push…", disabled: b.kind !== "local", action: () => void pushBranch(b.name) },
    { label: "Update", disabled: !isCurrent || !b.upstream, action: () => void updateBranch() },
    { separator: true },
    { label: `Merge into ${cur ?? "current"}`, disabled: isCurrent || !cur, action: () => void mergeIntoCurrent(b.name, b.name) },
    { label: `Rebase ${cur ?? "current"} onto ${b.name}…`, disabled: isCurrent || !cur, action: () => void rebaseCurrentOnto(b.name, b.name) },
    {
      label: `Compare with ${current ? current.name : "HEAD"}`,
      disabled: !view?.headOid || b.oid === view?.headOid,
      action: () => view?.headOid && void compare({ commit: view.headOid }, { commit: b.oid }, `${current?.name ?? "HEAD"} → ${b.name}`, current?.name ?? "HEAD", b.name),
    },
    { separator: true },
    { label: "Go to Commit", action: () => void jumpToOid(b.oid, true) },
    { label: filterBar.filter.branches.includes(b.name) ? "Remove from Log Filter" : "Show Only This Branch", action: () => filterBar.toggleBranch(b.name) },
    {
      label: `Show Commits Not in ${cur ?? "HEAD"}`,
      disabled: isCurrent || !view?.headOid,
      action: () => filterBar.set({ ...filterBar.filter, branches: [b.name, `^${cur ?? "HEAD"}`] }, true),
    },
    {
      label: `Show Commits of ${cur ?? "HEAD"} Not in ${b.name}`,
      disabled: isCurrent || !view?.headOid,
      action: () => filterBar.set({ ...filterBar.filter, branches: [cur ?? "HEAD", `^${b.name}`] }, true),
    },
    { separator: true },
    { label: "Rename…", disabled: b.kind !== "local", action: () => void renameBranch(b) },
    { label: b.kind === "tag" ? "Delete Tag…" : "Delete…", disabled: b.kind === "remote" || isCurrent, action: () => void deleteBranch(b) },
    { label: "Copy Name", action: () => void copyText(b.name) },
    { label: "Copy Revision Number", action: () => void copyText(b.oid) },
  ]);
};
/** The commits of the current comparison, when both sides are commits. */
function comparedCommits(): { from: string; to: string } | null {
  const from = typeof left === "object" ? ("commit" in left ? left.commit : `${left.parentOf}^`) : null;
  const to = typeof rightRev === "object" && "commit" in rightRev ? rightRev.commit : null;
  return from && to ? { from, to } : null;
}

async function fileChangesAction(files: Change[], kind: "revert" | "pick" | "get") {
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

changes.onContextMenu = (files, e) => {
  const c = files[0];
  const commits = !!comparedCommits() && files.every((f) => !f.rightRev);
  const plural = files.length > 1 ? ` (${files.length} files)` : "";
  showMenu(e.clientX, e.clientY, [
    { label: "Show Diff", disabled: files.length !== 1, action: () => void openFile(changeList.indexOf(c)) },
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

async function askForRepo() {
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

openBtn.addEventListener("click", () =>
  menuBelow(openBtn, [
    { label: "Open Repository…", shortcut: keymap.shortcut("open"), action: () => void askForRepo() },
    ...(settings.recent.length ? [{ separator: true } as MenuItem, { header: "Recent" } as MenuItem] : []),
    ...settings.recent.map((p) => ({ label: p, action: () => void openRepo(p) })),
  ]),
);
refreshBtn.addEventListener("click", () => void refresh());
fetchBtn.addEventListener("click", () => void fetchAll());
viewBtn.addEventListener("click", () => {
  const flip = (key: "intelliSort" | "showLongEdges", reload: boolean) => () => {
    settings[key] = !settings[key];
    save();
    if (reload) void reloadView();
  };
  const col = (key: "showAuthor" | "showDate" | "showHash") => () => {
    settings[key] = !settings[key];
    save();
    log.buildHeader();
  };
  menuBelow(viewBtn, [
    { header: "Graph" },
    { label: "IntelliSort", checked: settings.intelliSort, action: flip("intelliSort", true) },
    { label: "Show Long Edges", checked: settings.showLongEdges, action: flip("showLongEdges", true) },
    { label: "Collapse Linear Branches", checked: !!view?.collapsed, action: () => void collapse(view?.collapsed ? "none" : "all") },
    { separator: true },
    { header: "Columns" },
    { label: "Author", checked: settings.showAuthor, action: col("showAuthor") },
    { label: "Date", checked: settings.showDate, action: col("showDate") },
    { label: "Hash", checked: settings.showHash, action: col("showHash") },
    { separator: true },
    { label: "Branches Panel", checked: settings.showSidebar, shortcut: keymap.shortcut("branches"), action: toggleSidebar },
    { label: "Go to HEAD", disabled: !view?.headOid, action: () => view?.headOid && void jumpToOid(view.headOid, true) },
    { separator: true },
    { label: "Settings…", shortcut: keymap.shortcut("settings"), action: () => void openSettings() },
  ]);
});

function toggleSidebar() {
  settings.showSidebar = !settings.showSidebar;
  save();
  applyLayout();
}

// ---- welcome ----

function showWorkspace(show: boolean) {
  workspace.hidden = !show;
  welcome.hidden = show;
  if (!show) renderWelcome();
}

function renderWelcome() {
  const open = h("button", { class: "primary big" }, "Open Repository…");
  open.addEventListener("click", () => void askForRepo());
  const recent = h("div", { class: "recent" });
  for (const p of settings.recent) {
    const item = h("div", { class: "recent-item", title: p }, h("span", { class: "recent-name" }, p.split(/[\\/]/).pop() ?? p), h("span", { class: "recent-path" }, p));
    const remove = h("button", { class: "icon-button", title: "Remove from the list" }, "✕");
    remove.addEventListener("click", (e) => {
      e.stopPropagation();
      removeRecent(p);
      renderWelcome();
    });
    item.append(remove);
    item.addEventListener("click", () => void openRepo(p));
    recent.append(item);
  }
  welcome.replaceChildren(
    h(
      "div",
      { class: "welcome-card" },
      h("div", { class: "welcome-logo" }, h("span", { class: "dot a" }), h("span", { class: "dot b" }), h("span", { class: "dot c" })),
      h("h1", {}, "Rebased Lite"),
      h("p", { class: "muted-inline" }, "A light git log viewer with the Rebased commit graph."),
      open,
      settings.recent.length ? h("div", { class: "recent-title" }, "Recent repositories") : "",
      recent,
    ),
  );
}

// ---- keyboard ----

const keymap = new Keymap();
const typing = (t: HTMLElement) => t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || !!t.closest(".monaco-editor");
const nextTab = (d: number) => {
  if (settings.tabs.length < 2) return;
  const i = settings.tabs.indexOf(settings.activeTab ?? "");
  void switchTab(settings.tabs[(i + d + settings.tabs.length) % settings.tabs.length]);
};
for (const a of [
  { id: "open", label: "Open Repository", defaults: ["Mod+O"], run: () => void askForRepo() },
  { id: "refresh", label: "Refresh", defaults: ["Mod+R", "F5"], run: () => void refresh() },
  { id: "fetch", label: "Fetch", defaults: [], run: () => view && void fetchAll() },
  { id: "update", label: "Update the Current Branch", defaults: ["Mod+T"], run: () => view && void updateBranch() },
  { id: "push", label: "Push", defaults: ["Mod+Shift+K"], run: () => view && void pushBranch() },
  {
    id: "commit",
    label: "Commit (show the Commit tab)",
    defaults: ["Mod+K"],
    run: () => {
      showLeftTab("commit");
      commitPanel.focusMessage();
    },
  },
  { id: "undo", label: "Undo the Last Operation", defaults: ["Mod+Z"], run: () => view && void undoLast(), when: (t: HTMLElement) => !typing(t) },
  { id: "filter", label: "Find in the Log (filter)", defaults: ["Mod+F"], run: () => { filterBar.text.focus(); filterBar.text.select(); }, when: (t: HTMLElement) => !t.closest(".monaco-editor") },
  {
    id: "branches",
    label: "Branches Panel",
    defaults: ["Mod+1"],
    run: () => {
      if (settings.showSidebar && settings.leftTab !== "branches") showLeftTab("branches");
      else toggleSidebar();
    },
  },
  { id: "localHistory", label: "Local History", defaults: [], run: () => view && showLocalHistory("") },
  { id: "nextTab", label: "Next Tab", defaults: ["Mod+PageDown"], run: () => nextTab(1) },
  { id: "previousTab", label: "Previous Tab", defaults: ["Mod+PageUp"], run: () => nextTab(-1) },
  { id: "nextChange", label: "Next Change in the Diff", defaults: ["F7"], run: () => diff.goToDiff("next") },
  { id: "previousChange", label: "Previous Change in the Diff", defaults: ["Shift+F7"], run: () => diff.goToDiff("previous") },
  { id: "nextFile", label: "Next File", defaults: ["Alt+ArrowDown"], run: () => (diffSource === "local" ? commitPanel.move(1) : changes.move(1)) },
  { id: "previousFile", label: "Previous File", defaults: ["Alt+ArrowUp"], run: () => (diffSource === "local" ? commitPanel.move(-1) : changes.move(-1)) },
  {
    id: "copyHash",
    label: "Copy the Revision Number",
    defaults: ["Mod+C"],
    run: () => {
      void copyText(selected.map((s) => s.oid).join(" "));
      statusRight.textContent = "Copied the revision number";
    },
    when: (t: HTMLElement) => !typing(t) && !!t.closest(".log") && selected.length > 0,
  },
  { id: "settings", label: "Settings", defaults: [isMac ? "Mod+Comma" : "Mod+Alt+S"], run: () => void openSettings() },
] as KeyAction[]) keymap.add(a);

// ---- settings ----

let autoFetchTimer = 0;
function scheduleAutoFetch() {
  clearInterval(autoFetchTimer);
  if (settings.autoFetchMinutes > 0) {
    autoFetchTimer = window.setInterval(() => {
      if (view && busy === 0 && !document.hidden) void fetchAll();
    }, settings.autoFetchMinutes * 60_000);
  }
}

/** Applies the settings that live outside the front end: the git program and the Local History limits. */
async function applyBackendSettings() {
  if (settings.gitPath) {
    try {
      await api.setGitProgram(settings.gitPath);
    } catch (e) {
      toast(`The git program in the settings does not work; git from PATH runs instead. ${String(e).replace(/^Error: /, "")}`, "error");
    }
  }
  await api.setLocalHistoryLimits(settings.historyDays, settings.historyMaxMb).catch(() => {});
}

async function openSettings() {
  const next = await openSettingsDialog({ keymap, testGit: (p) => api.setGitProgram(p).finally(() => api.setGitProgram(settings.gitPath).catch(() => {})), pickFile: () => pickFile("Git executable") });
  if (!next) return;
  const gitChanged = next.gitPath !== settings.gitPath;
  const historyChanged = next.historyDays !== settings.historyDays || next.historyMaxMb !== settings.historyMaxMb;
  if (gitChanged) {
    try {
      const version = await api.setGitProgram(next.gitPath);
      statusRight.textContent = `git ${version}`;
    } catch (e) {
      toast(String(e).replace(/^Error: /, ""), "error");
      next.gitPath = settings.gitPath;
    }
  }
  Object.assign(settings, next);
  save();
  applyTheme();
  applyDiffSettings();
  scheduleAutoFetch();
  if (historyChanged) await api.setLocalHistoryLimits(settings.historyDays, settings.historyMaxMb).catch(() => {});
  if (gitChanged && view) void refresh();
}

window.addEventListener("keydown", (e) => {
  // An open dialog handles its own keys.
  if (document.querySelector(".overlay, .merge-overlay")) return;
  keymap.handle(e);
});

// ---- start ----

applyLayout();
showLeftTab(settings.leftTab);
applyTheme();
showWorkspace(false);
await applyBackendSettings();
scheduleAutoFetch();
// The tabs of the last session come back; only the active one loads now, the others on first use.
const initial = new URLSearchParams(location.search).get("repo") ?? (await initialPath());
if (initial) void openRepo(initial);
else if (settings.activeTab && settings.tabs.includes(settings.activeTab)) void switchTab(settings.activeTab);
else settings.tabs = [];
renderTabs();
