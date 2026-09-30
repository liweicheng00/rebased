// Remotes, the tracked branch, favorite branches and Compare Branches.

import { api, type BranchInfo, type RemoteInfo } from "./api";
import { openCompare, WORKTREE } from "./compare-view";
import { menuBelow, type MenuItem, showMenu } from "./context-menu";
import { confirmDialog, formDialog } from "./dialogs";
import { keymap } from "./keyboard";
import { toast } from "./notify";
import { currentBranch, runOp } from "./operations";
import { openRemotesDialog } from "./remotes-dialog";
import { jumpToOid, reloadView } from "./repo";
import { collapse } from "./selection";
import { save, settings } from "./settings";
import { openSettings } from "./settings-flow";
import { log, sidebar, toggleSidebar, viewBtn } from "./shell";
import { app } from "./state";

export async function fetchRemote(name: string) {
  await runOp({ op: "fetchRemote", name }, `Fetching ${name}`);
}

async function addRemote() {
  const r = await formDialog("Add Remote", [
    { key: "name", label: "Name", value: app.refs.some((b) => b.kind === "remote") ? "" : "origin", placeholder: "origin" },
    { key: "url", label: "URL", placeholder: "https://github.com/owner/repo.git or git@host:owner/repo.git" },
    { key: "fetch", label: "Fetch it now", type: "checkbox", value: true },
  ], "Add");
  if (!r || !String(r.name).trim() || !String(r.url).trim()) return;
  const name = String(r.name).trim();
  const out = await runOp({ op: "addRemote", name, url: String(r.url).trim() }, `Adding ${name}`);
  if (out?.result.ok && r.fetch) await fetchRemote(name);
}

async function editRemote(remote: RemoteInfo) {
  const r = await formDialog(`Edit Remote ${remote.name}`, [
    { key: "name", label: "Name", value: remote.name },
    { key: "url", label: "URL", value: remote.fetchUrl },
    { key: "pushUrl", label: "Push URL (empty: the same as the URL)", value: remote.pushUrl ?? "" },
  ], "Save");
  if (!r) return;
  const name = String(r.name).trim();
  const url = String(r.url).trim();
  const pushUrl = String(r.pushUrl).trim();
  if (url !== remote.fetchUrl || pushUrl !== (remote.pushUrl ?? "")) await runOp({ op: "setRemoteUrl", name: remote.name, url, pushUrl }, `Changing ${remote.name}`);
  if (name && name !== remote.name) await runOp({ op: "renameRemote", from: remote.name, to: name }, `Renaming ${remote.name}`);
}

async function removeRemote(name: string) {
  if (!(await confirmDialog("Remove remote", `Remove the remote ${name}? Its remote branches go away from the log. The repository on the server does not change.`, "Remove", true))) return;
  await runOp({ op: "removeRemote", name }, `Removing ${name}`);
}

export async function manageRemotes() {
  if (!app.view) return;
  await openRemotesDialog({
    load: api.remotes,
    add: addRemote,
    edit: editRemote,
    fetch: (r) => fetchRemote(r.name),
    remove: (r) => removeRemote(r.name),
  });
}

/** Opens Compare Branches. The right side can be the working tree. */
export function compareBranches(leftRef: string, rightRef: string) {
  const names = [
    ...app.refs.filter((b) => b.kind === "local").map((b) => b.name),
    ...app.refs.filter((b) => b.kind === "remote").map((b) => b.name),
    ...app.refs.filter((b) => b.kind === "tag").map((b) => b.name),
  ];
  const head = currentBranch() ?? "HEAD";
  if (!names.includes(head)) names.unshift(head);
  for (const n of [leftRef, rightRef]) if (n !== WORKTREE && !names.includes(n)) names.unshift(n);
  void openCompare(leftRef, rightRef, {
    refs: names,
    head,
    compareRefs: api.compareRefs,
    changes: async (l, r) => (await api.compare(l, r)).changes,
    pair: api.filePair,
    showInLog: (oid) => void jumpToOid(oid, true),
  });
}

/** The favorite refs of the active repository, from its git dir. */
let favorites: string[] = [];

export function favoritesOf(): string[] {
  return favorites;
}

/** Loads the favorites of the active repository. Without a choice yet, main and master are favorites.
 * An old front end kept the favorites in the browser storage; they move to the repository. */
export async function loadFavorites() {
  const root = app.view?.root ?? "";
  const stored = await api.favorites().catch(() => null);
  const old = settings.favorites[root];
  favorites = stored ?? old ?? ["refs/heads/main", "refs/heads/master"];
  if (!stored && old) {
    await api.setFavorites(old).catch(() => {});
    delete settings.favorites[root];
    save();
  }
  sidebar.setFavorites(favorites);
}

export function toggleFavorite(b: BranchInfo) {
  if (!app.view) return;
  favorites = favorites.includes(b.full) ? favorites.filter((x) => x !== b.full) : [...favorites, b.full];
  sidebar.setFavorites(favorites);
  void api.setFavorites(favorites).catch((e) => toast(String(e).replace(/^Error: /, ""), "error"));
}
sidebar.onToggleFavorite = toggleFavorite;

sidebar.onRemoteMenu = (remote, e) =>
  showMenu(e.clientX, e.clientY, [
    { label: `Fetch ${remote}`, action: () => void fetchRemote(remote) },
    {
      label: "Edit Remote…",
      action: async () => {
        const r = (await api.remotes()).find((x) => x.name === remote);
        if (r) await editRemote(r);
      },
    },
    { label: "Remove Remote…", action: () => void removeRemote(remote) },
    { separator: true },
    { label: "Manage Remotes…", action: () => void manageRemotes() },
  ]);

/** Chooses the tracked branch of a local branch from the remote branches. */
async function setTracked(b: BranchInfo) {
  const remotes = app.refs.filter((x) => x.kind === "remote").map((x) => x.name);
  if (!remotes.length) return toast("There are no remote branches. Fetch or add a remote first.", "error");
  const guess = b.upstream ?? remotes.find((x) => x.endsWith(`/${b.name}`)) ?? remotes[0];
  const r = await formDialog(`Tracked Branch of ${b.name}`, [{ key: "upstream", label: "Remote branch", type: "select", value: guess, options: remotes.map((x) => [x, x]) }], "Set");
  if (r) await runOp({ op: "setUpstream", branch: b.name, upstream: String(r.upstream) }, `Setting the tracked branch of ${b.name}`);
}

/** Remote actions of a branch or a tag, for its context menu. */
export function remoteRefItems(b: BranchInfo): MenuItem[] {
  const remotes = [...new Set(app.refs.filter((x) => x.kind === "remote").map((x) => x.name.split("/")[0]))];
  if (b.kind === "local") {
    return [
      { label: b.upstream ? `Change Tracked Branch (${b.upstream})…` : "Set Tracked Branch…", action: () => void setTracked(b) },
      { label: "Stop Tracking", disabled: !b.upstream, action: () => void runOp({ op: "setUpstream", branch: b.name, upstream: null }, `Stop tracking for ${b.name}`) },
    ];
  }
  if (b.kind === "remote") {
    const slash = b.name.indexOf("/");
    const remote = b.name.slice(0, slash);
    const branch = b.name.slice(slash + 1);
    return [
      { label: `Fetch ${remote}`, action: () => void fetchRemote(remote) },
      {
        label: "Delete from Remote…",
        action: async () => {
          if (!(await confirmDialog("Delete remote branch", `Delete the branch ${branch} on ${remote}? Other people lose it too when they fetch.`, "Delete", true))) return;
          await runOp({ op: "deleteRemoteRef", remote, name: `refs/heads/${branch}` }, `Deleting ${b.name}`);
        },
      },
    ];
  }
  return remotes.flatMap((remote) => [
    { label: `Push Tag to ${remote}`, action: () => void runOp({ op: "pushTag", remote, tag: b.name }, `Pushing ${b.name}`) } as MenuItem,
    {
      label: `Delete Tag from ${remote}…`,
      action: async () => {
        if (!(await confirmDialog("Delete remote tag", `Delete the tag ${b.name} on ${remote}? The local tag stays.`, "Delete", true))) return;
        await runOp({ op: "deleteRemoteRef", remote, name: `refs/tags/${b.name}` }, `Deleting ${b.name} from ${remote}`);
      },
    } as MenuItem,
  ]);
}
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
    { label: "Collapse Linear Branches", checked: !!app.view?.collapsed, action: () => void collapse(app.view?.collapsed ? "none" : "all") },
    { separator: true },
    { header: "Columns" },
    { label: "Author", checked: settings.showAuthor, action: col("showAuthor") },
    { label: "Date", checked: settings.showDate, action: col("showDate") },
    { label: "Hash", checked: settings.showHash, action: col("showHash") },
    { separator: true },
    { label: "Branches Panel", checked: settings.showSidebar, shortcut: keymap.shortcut("branches"), action: toggleSidebar },
    { label: "Go to HEAD", disabled: !app.view?.headOid, action: () => app.view?.headOid && void jumpToOid(app.view.headOid, true) },
    { separator: true },
    { label: "Settings…", shortcut: keymap.shortcut("settings"), action: () => void openSettings() },
  ]);
});
