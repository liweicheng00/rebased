import "./style.css";
import { api, initialPath, inTauri, pickFolder, type BranchInfo, type Change, type RevSpec, type Row, type ViewResult } from "./api";
import { ChangesPanel } from "./changes-panel";
import { menuBelow, showMenu, type MenuItem } from "./context-menu";
import { DetailsPanel } from "./details-panel";
import { DiffView, setMonacoTheme } from "./diff-view";
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

let view: ViewResult | null = null;
let refs: BranchInfo[] = [];
let selected: Row[] = [];
const authors = new Set<string>();

// ---- layout ----

const openBtn = h("button", { class: "tb-button", title: `Open a repository (${mod}O)` }, "📂 Open ▾");
const refreshBtn = h("button", { class: "tb-button", title: `Reload commits and branches (${mod}R)`, disabled: true }, "⟳ Refresh");
const fetchBtn = h("button", { class: "tb-button", title: "Fetch all remotes", disabled: true }, "⇣ Fetch");
const repoLabel = h("span", { class: "tb-repo" });
const viewBtn = h("button", { class: "tb-button", title: "View options" }, "View ▾");
const themeBtn = h("button", { class: "tb-button", title: "Theme" }, "◐");
const toolbar = h("header", { class: "toolbar" }, openBtn, refreshBtn, fetchBtn, repoLabel, h("span", { class: "spacer" }), viewBtn, themeBtn);

const statusLeft = h("span", { class: "sb-left" });
const statusMid = h("span", { class: "sb-mid" });
const statusRight = h("span", { class: "sb-right" });
const statusBar = h("footer", { class: "statusbar" }, statusLeft, statusMid, statusRight);

const sideGrip = h("div", { class: "vgrip" });
const rightGrip = h("div", { class: "vgrip" });
const diffGrip = h("div", { class: "hgrip-row" });
const detailsGrip = h("div", { class: "hgrip-row" });
const center = h("section", { class: "center" }, filterBar.el, log.el);
const right = h("section", { class: "right" }, changes.el, detailsGrip, details.el);
const top = h("div", { class: "top" }, sidebar.el, sideGrip, center, rightGrip, right);
const workspace = h("main", { class: "workspace" }, top, diffGrip, diff.el);
const welcome = h("main", { class: "welcome" });
const app = document.getElementById("app")!;
app.append(toolbar, welcome, workspace, statusBar);

function applyLayout() {
  top.style.gridTemplateColumns = `${settings.showSidebar ? `${settings.sidebarWidth}px 4px` : "0 0"} minmax(300px, 1fr) 4px ${settings.rightWidth}px`;
  sidebar.el.hidden = !settings.showSidebar;
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
  const branch = view.head?.replace("refs/heads/", "") ?? (view.headOid ? `detached at ${view.headOid.slice(0, 8)}` : "no commits");
  repoLabel.replaceChildren(h("b", {}, view.root.split(/[\\/]/).pop() ?? view.root), h("span", { class: "tb-branch" }, ` ⑂ ${branch}`));
  statusLeft.textContent = view.root;
  statusMid.textContent = view.filtered
    ? `${view.rowCount.toLocaleString()} of ${view.totalCommits.toLocaleString()} commits match the filter`
    : `${view.totalCommits.toLocaleString()} commits`;
  filterBar.setInfo(view.filtered ? `${view.rowCount.toLocaleString()} of ${view.totalCommits.toLocaleString()}` : "");
  if (!busy) statusRight.textContent = `loaded in ${view.loadMs} ms`;
}

// ---- repository ----

function viewSettings() {
  return { intelliSort: settings.intelliSort, showLongEdges: settings.showLongEdges, filter: filterBar.filter };
}

async function openRepo(path: string) {
  const r = await task("Opening repository", () => api.open(path, { ...viewSettings(), filter: emptyFilter() }));
  if (!r) return;
  filterBar.set(emptyFilter(), false);
  addRecent(r.root);
  authors.clear();
  showWorkspace(true);
  await applyView(r, false);
  await loadRefs();
  if (r.headOid) void jumpToOid(r.headOid, true);
}

async function applyView(r: ViewResult, keepSelection: boolean) {
  const keepOids = keepSelection ? selected.map((s) => s.oid) : [];
  view = r;
  document.title = `${r.root.split(/[\\/]/).pop()} – Rebased Lite`;
  refreshBtn.disabled = fetchBtn.disabled = false;
  updateStatus();
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
  refs = (await api.refs().catch(() => [])) as BranchInfo[];
  sidebar.setRefs(refs);
  filterBar.branchNames = refs.filter((b) => b.kind !== "tag").map((b) => b.name);
}

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
    const pair = await api.filePair(left, rightRev, c.path, c.old_path);
    if (req !== request || active !== i) return;
    diff.show(c, pair.left, pair.right);
  } catch (e) {
    if (req === request) diff.message(String(e));
  }
}

function showSelection(rows: Row[]) {
  selected = rows;
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
diff.onNextFile = () => changes.move(1);
diff.onPrevFile = () => changes.move(-1);
details.onJump = (oid) => void jumpToOid(oid, true);

// ---- menus ----

function rowMenu(r: Row, e: MouseEvent) {
  const items: MenuItem[] = [
    { label: selected.length > 1 ? "Copy Revision Numbers" : "Copy Revision Number", shortcut: `${mod}C`, action: () => void copyText(selected.length > 1 ? selected.map((s) => s.oid).join(" ") : r.oid) },
    { label: "Copy Subject", action: () => void copyText(r.subject) },
    { separator: true },
    { label: "Compare with Parent", action: () => log.select([r.row]) },
    { label: "Compare with Working Tree", action: () => compareWithWorktree(r) },
  ];
  if (selected.length === 2) items.push({ label: "Compare Selected Commits", action: () => showSelection(selected) });
  items.push({ separator: true }, { label: "Go to Parent", action: () => void api.commit(r.oid).then((c) => (c.parents[0] ? jumpToOid(c.parents[0], true) : false)) });
  items.push({ separator: true }, { header: "Filter" });
  items.push({ label: `Show Commits by ${r.author}`, action: () => filterBar.set({ ...filterBar.filter, author: r.author }, true) });
  for (const ref of r.refs.filter((x) => x.kind === "local" || x.kind === "remote")) {
    items.push({ label: `Show Only ${ref.name}`, action: () => filterBar.set({ ...filterBar.filter, branches: [ref.name] }, true) });
  }
  showMenu(e.clientX, e.clientY, items);
}
log.onContextMenu = rowMenu;

sidebar.onNavigate = (b) => void jumpToOid(b.oid, true);
sidebar.onToggleFilter = (b) => filterBar.toggleBranch(b.name);
sidebar.onContextMenu = (b, e) => {
  const current = refs.find((x) => x.current);
  showMenu(e.clientX, e.clientY, [
    { label: "Go to Commit", action: () => void jumpToOid(b.oid, true) },
    { label: filterBar.filter.branches.includes(b.name) ? "Remove from Log Filter" : "Show Only This Branch", action: () => filterBar.toggleBranch(b.name) },
    {
      label: `Compare with ${current ? current.name : "HEAD"}`,
      disabled: !view?.headOid || b.oid === view?.headOid,
      action: () => view?.headOid && void compare({ commit: view.headOid }, { commit: b.oid }, `${current?.name ?? "HEAD"} → ${b.name}`, current?.name ?? "HEAD", b.name),
    },
    { separator: true },
    { label: "Copy Name", action: () => void copyText(b.name) },
    { label: "Copy Revision Number", action: () => void copyText(b.oid) },
  ]);
};
changes.onContextMenu = (c, e) =>
  showMenu(e.clientX, e.clientY, [
    { label: "Show Diff", action: () => void openFile(changeList.indexOf(c)) },
    { label: "Copy Path", action: () => void copyText(c.path) },
    { label: "Copy File Name", action: () => void copyText(c.path.split("/").pop() ?? c.path) },
  ]);

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
    { label: "Open Repository…", shortcut: `${mod}O`, action: () => void askForRepo() },
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
    { separator: true },
    { header: "Columns" },
    { label: "Author", checked: settings.showAuthor, action: col("showAuthor") },
    { label: "Date", checked: settings.showDate, action: col("showDate") },
    { label: "Hash", checked: settings.showHash, action: col("showHash") },
    { separator: true },
    { label: "Branches Panel", checked: settings.showSidebar, shortcut: `${mod}1`, action: toggleSidebar },
    { label: "Go to HEAD", disabled: !view?.headOid, action: () => view?.headOid && void jumpToOid(view.headOid, true) },
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

window.addEventListener("keydown", (e) => {
  const cmd = e.metaKey || e.ctrlKey;
  const target = e.target as HTMLElement;
  const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.closest(".monaco-editor");
  if (cmd && e.key.toLowerCase() === "o") {
    e.preventDefault();
    void askForRepo();
  } else if ((cmd && e.key.toLowerCase() === "r") || e.key === "F5") {
    e.preventDefault();
    void refresh();
  } else if (cmd && e.key.toLowerCase() === "f" && !target.closest(".monaco-editor")) {
    e.preventDefault();
    filterBar.text.focus();
    filterBar.text.select();
  } else if (cmd && e.key === "1") {
    e.preventDefault();
    toggleSidebar();
  } else if (e.key === "F7") {
    e.preventDefault();
    diff.goToDiff(e.shiftKey ? "previous" : "next");
  } else if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    e.preventDefault();
    changes.move(e.key === "ArrowDown" ? 1 : -1);
  } else if (cmd && e.key.toLowerCase() === "c" && !typing && target.closest(".log") && selected.length) {
    e.preventDefault();
    void copyText(selected.map((s) => s.oid).join(" "));
    statusRight.textContent = "Copied the revision number";
  }
});

// ---- start ----

applyLayout();
applyTheme();
showWorkspace(false);
const initial = new URLSearchParams(location.search).get("repo") ?? (await initialPath());
if (initial) void openRepo(initial);
