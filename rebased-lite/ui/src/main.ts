import "./style.css";
import {
  api,
  initialPath,
  inTauri,
  pickFolder,
  type BranchInfo,
  type Change,
  type Op,
  type OpOutcome,
  type PlanEntry,
  type RecentBranch,
  type RepoState,
  type RevSpec,
  type Row,
  type ViewResult,
  type Worktree,
} from "./api";
import { showBranchSwitcher } from "./branch-switcher";
import { confirmDialog, formDialog, interactiveRebaseDialog, messageDialog, resetDialog } from "./dialogs";
import { toast } from "./notify";
import { OpBanner } from "./op-banner";
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
const repoLabel = h("span", { class: "tb-repo" });
const branchBtn = h("button", { class: "tb-button tb-branch-button", title: "Switch branch (recent branches first)", hidden: true }, "⑂ ▾");
const viewBtn = h("button", { class: "tb-button", title: "View options" }, "View ▾");
const themeBtn = h("button", { class: "tb-button", title: "Theme" }, "◐");
const toolbar = h("header", { class: "toolbar" }, openBtn, refreshBtn, fetchBtn, repoLabel, branchBtn, h("span", { class: "spacer" }), viewBtn, themeBtn);

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
  const [r, rec, wt, st] = await Promise.all([
    api.refs().catch(() => [] as BranchInfo[]),
    api.recentBranches().catch(() => [] as RecentBranch[]),
    api.worktrees().catch(() => [] as Worktree[]),
    api.repoState().catch(() => null),
  ]);
  refs = r;
  recent = rec;
  worktrees = wt;
  repoState = st;
  sidebar.setRefs(refs);
  sidebar.setRecent(recent);
  sidebar.setWorktrees(worktrees);
  banner.update(repoState);
  filterBar.branchNames = refs.filter((b) => b.kind !== "tag").map((b) => b.name);
  updateStatus();
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
async function runOp(op: Op, label: string): Promise<OpOutcome | undefined> {
  const outcome = await task(label, () => api.runOp(op));
  if (!outcome) return undefined;
  await applyView(outcome.view, true);
  await loadRefs();
  const r = outcome.result;
  if (r.ok) {
    const undoTo = r.undoTo;
    const head = outcome.head;
    toast(
      r.message,
      "success",
      undoTo && head && undoTo !== head
        ? { label: "Undo", run: () => void runOp({ op: "undo", to: undoTo, expectedHead: head }, "Undoing") }
        : undefined,
    );
    statusRight.textContent = r.message;
  } else {
    toast(r.message, "error");
    statusRight.textContent = r.message;
    statusRight.className = "sb-right error";
  }
  return outcome;
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
banner.onShowFile = (path) => {
  if (!view?.headOid) return;
  void compare({ commit: view.headOid }, "worktree", "HEAD → working tree", "HEAD", "working tree").then(() => {
    const i = changeList.findIndex((c) => c.path === path);
    if (i >= 0) void openFile(i);
  });
};

sidebar.onCheckout = (b) => void checkoutBranch(b);
sidebar.onAddWorktree = () => void addWorktree();
sidebar.onOpenWorktree = (w) => void openRepo(w.path);
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

// ---- menus ----

async function rowMenu(r: Row, e: MouseEvent) {
  const selected = await log.selectedRows();
  if (!selected.length) selected.push(r);
  const multi = selected.length > 1;
  const cur = currentBranch();
  const items: MenuItem[] = [
    { label: multi ? "Copy Revision Numbers" : "Copy Revision Number", shortcut: `${mod}C`, action: () => void copyText(multi ? selected.map((s) => s.oid).join(" ") : r.oid) },
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
    { separator: true },
    { label: "Rename…", disabled: b.kind !== "local", action: () => void renameBranch(b) },
    { label: b.kind === "tag" ? "Delete Tag…" : "Delete…", disabled: b.kind === "remote" || isCurrent, action: () => void deleteBranch(b) },
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
    { label: "Collapse Linear Branches", checked: !!view?.collapsed, action: () => void collapse(view?.collapsed ? "none" : "all") },
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
