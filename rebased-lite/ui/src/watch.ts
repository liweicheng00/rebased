// Credential prompts, and the reload when files or refs change outside the app.

import { api } from "./api";
import { showLocalDiff } from "./commit-flow";
import { credentialDialog } from "./dialogs";
import { applyView, jumpToOid, loadLocalChanges, loadRefs, reloadView } from "./repo";
import { settings } from "./settings";
import { authors, banner, commitPanel, filterBar, log, updateStatus } from "./shell";
import { app } from "./state";

// While an operation runs, git can ask for a password through the askpass program of the app.
const askpassShown = new Set<number>();
let askpassBusy = false;
async function pollAskpass() {
  if (app.busy === 0 || askpassBusy) return;
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

/** The watcher counters that the view shows; changes after a write operation of the app are expected. */
let filesChangedWhileQuiet = false;

async function pollWatch() {
  if (!app.view || app.busy > 0 || document.hidden || !settings.autoRefresh) return;
  const c = await api.watchState().catch(() => null);
  if (!c) return;
  const before = app.watchSeen;
  app.watchSeen = c;
  if (!before) return;
  if (Date.now() < app.watchQuietUntil || app.busy > 0) {
    // The operation itself changed these files, but a file can also change on disk in this time. The
    // local changes load once more after the quiet time; that is cheap. Ref changes stay ignored here,
    // because a graph reload after each operation costs much on a large repository.
    if (c.files !== before.files) filesChangedWhileQuiet = true;
    return;
  }
  if (filesChangedWhileQuiet && c.files === before.files && c.repo === before.repo) {
    filesChangedWhileQuiet = false;
    await loadLocalChanges();
    const f = commitPanel.activeFile();
    if (app.diffSource === "local" && f) void showLocalDiff(f);
    return;
  }
  filesChangedWhileQuiet = false;
  if (c.repo !== before.repo) {
    const r = await api.refresh().catch(() => null);
    if (r) {
      await applyView(r, true);
      await loadRefs();
    }
  } else if (c.files !== before.files) {
    app.repoState = await api.repoState().catch(() => app.repoState);
    banner.update(app.repoState);
    updateStatus();
    await loadLocalChanges();
    const f = commitPanel.activeFile();
    if (app.diffSource === "local" && f) void showLocalDiff(f);
  }
}
setInterval(() => void pollWatch(), 1000);

// Files change outside the app; reload the local changes when the window gets the focus.
let focusTimer = 0;
window.addEventListener("focus", () => {
  if (!app.view || Date.now() - focusTimer < 1500) return;
  focusTimer = Date.now();
  void api.repoState().then((st) => {
    app.repoState = st;
    banner.update(st);
    updateStatus();
  }).catch(() => {});
  void loadLocalChanges();
});

filterBar.onChange = () => void reloadView();
filterBar.onJump = (q) => jumpToOid(q, true);
log.onRowsLoaded = (rows) => {
  const before = authors.size;
  for (const r of rows) if (r.author) authors.add(r.author);
  if (authors.size !== before) filterBar.setAuthors([...authors].sort());
};
