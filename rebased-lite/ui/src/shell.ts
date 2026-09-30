// The components of the window, the layout, the theme and the status bar.

import { ApiError, errorHint } from "./api";
import { ChangesPanel } from "./changes-panel";
import { CommitPanel } from "./commit-panel";
import { menuBelow } from "./context-menu";
import { DetailsPanel } from "./details-panel";
import { DiffView, setMonacoTheme } from "./diff-view";
import { dragResize, h } from "./dom";
import { FilterBar } from "./filter-bar";
import { LogView } from "./log-view";
import { toast } from "./notify";
import { OpBanner } from "./op-banner";
import { save, settings } from "./settings";
import { Sidebar } from "./sidebar";
import { StashPanel } from "./stash-panel";
import { app } from "./state";

export const mod = navigator.platform.includes("Mac") ? "⌘" : "Ctrl+";

export const log = new LogView();
export const sidebar = new Sidebar();
export const filterBar = new FilterBar();
export const changes = new ChangesPanel();
export const details = new DetailsPanel();
export const diff = new DiffView();
export const commitPanel = new CommitPanel();
export const stashPanel = new StashPanel();

export const banner = new OpBanner();
export const authors = new Set<string>();

export const openBtn = h("button", { class: "tb-button", title: `Open a repository (${mod}O)` }, "📂 Open ▾");
export const refreshBtn = h("button", { class: "tb-button", title: `Reload commits and branches (${mod}R)`, disabled: true }, "⟳ Refresh");
export const fetchBtn = h("button", { class: "tb-button", title: "Fetch all remotes, or one remote", disabled: true }, "⇣ Fetch ▾");
export const updateBtn = h("button", { class: "tb-button", title: `Update the current branch: fetch, then merge or rebase (${mod}T)`, disabled: true }, "↧ Update");
export const pushBtn = h("button", { class: "tb-button", title: `Push the current branch (${mod}⇧K)`, disabled: true }, "↥ Push");
export const localHistoryBtn = h("button", { class: "tb-button", title: "Local History: the recent versions of changed files", disabled: true }, "🕘 Local History");
const repoLabel = h("span", { class: "tb-repo" });
export const branchBtn = h("button", { class: "tb-button tb-branch-button", title: "Switch branch (recent branches first)", hidden: true }, "⑂ ▾");
export const viewBtn = h("button", { class: "tb-button", title: "View options" }, "View ▾");
const themeBtn = h("button", { class: "tb-button", title: "Theme" }, "◐");
export const settingsBtn = h("button", { class: "tb-button", title: "Settings" }, "⚙");
const toolbar = h("header", { class: "toolbar" }, openBtn, refreshBtn, fetchBtn, updateBtn, pushBtn, localHistoryBtn, repoLabel, branchBtn, h("span", { class: "spacer" }), viewBtn, themeBtn, settingsBtn);

export const tabBar = h("nav", { class: "tabbar", hidden: true });

const statusLeft = h("span", { class: "sb-left" });
const statusMid = h("span", { class: "sb-mid" });
export const statusRight = h("span", { class: "sb-right" });
const statusBar = h("footer", { class: "statusbar" }, statusLeft, statusMid, statusRight);

const sideGrip = h("div", { class: "vgrip" });
const rightGrip = h("div", { class: "vgrip" });
const diffGrip = h("div", { class: "hgrip-row" });
const detailsGrip = h("div", { class: "hgrip-row" });
const center = h("section", { class: "center" }, banner.el, filterBar.el, log.el);
const right = h("section", { class: "right" }, changes.el, detailsGrip, details.el);
const tabBranches = h("button", { class: "lp-tab", title: `Branches (${mod}1)` }, "Branches");
export const tabCommit = h("button", { class: "lp-tab", title: `Commit (${mod}K)` }, "Commit");
export const tabStash = h("button", { class: "lp-tab", title: "Stashes" }, "Stash");
const leftPane = h("aside", { class: "leftpane" }, h("div", { class: "lp-tabs" }, tabBranches, tabCommit, tabStash), sidebar.el, commitPanel.el, stashPanel.el);
export function showLeftTab(tab: "branches" | "commit" | "stash") {
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
export const workspace = h("main", { class: "workspace" }, top, diffGrip, diff.el);
export const welcome = h("main", { class: "welcome" });
const appRoot = document.getElementById("app")!;
appRoot.append(toolbar, tabBar, welcome, workspace, statusBar);

export function applyLayout() {
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

const darkQuery = matchMedia("(prefers-color-scheme: dark)");
export function applyTheme() {
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

export async function task<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  app.busy++;
  statusRight.textContent = label + "…";
  statusRight.className = "sb-right busy";
  try {
    const r = await fn();
    statusRight.textContent = "";
    statusRight.className = "sb-right";
    return r;
  } catch (e) {
    const message = String(e).replace(/^Error: /, "");
    statusRight.textContent = message;
    statusRight.className = "sb-right error";
    // A failure that the user must fix outside the app gets a notification with what to do.
    const hint = e instanceof ApiError ? errorHint(e.kind) : "";
    if (hint) toast(`${message}\n${hint}`, "error");
    return undefined;
  } finally {
    app.busy--;
  }
}

export function updateStatus() {
  if (!app.view) return;
  const branch = app.repoState?.rebasing
    ? `rebasing ${app.repoState.rebasing}`
    : (app.view.head?.replace("refs/heads/", "") ?? (app.view.headOid ? `detached at ${app.view.headOid.slice(0, 8)}` : "no commits"));
  repoLabel.replaceChildren(h("b", {}, app.view.root.split(/[\\/]/).pop() ?? app.view.root));
  branchBtn.hidden = false;
  branchBtn.textContent = `⑂ ${branch} ▾`;
  const changed = app.repoState?.changedFiles ?? 0;
  statusLeft.textContent = app.view.root + (changed ? `  ·  ${changed} changed file${changed === 1 ? "" : "s"}` : "");
  statusMid.textContent = app.view.filtered
    ? `${app.view.rowCount.toLocaleString()} of ${app.view.totalCommits.toLocaleString()} commits match the filter`
    : `${app.view.totalCommits.toLocaleString()} commits`;
  if (app.view.collapsed) statusMid.textContent += ` · ${app.view.rowCount.toLocaleString()} rows shown, linear branches collapsed`;
  filterBar.setInfo(app.view.filtered ? `${app.view.rowCount.toLocaleString()} of ${app.view.totalCommits.toLocaleString()}` : "");
  if (!app.busy) statusRight.textContent = `loaded in ${app.view.loadMs} ms`;
}

export function toggleSidebar() {
  settings.showSidebar = !settings.showSidebar;
  save();
  applyLayout();
}
