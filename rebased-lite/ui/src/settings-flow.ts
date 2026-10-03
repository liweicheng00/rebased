// The Settings dialog and the settings that the backend needs.

import { api, type BackendSettings, pickFile } from "./api";
import { applyDiffSettings } from "./diff-view";
import { keymap } from "./keyboard";
import { toast } from "./notify";
import { fetchAll, refresh } from "./repo";
import { save, settings } from "./settings";
import { openSettingsDialog } from "./settings-dialog";
import { applyTheme, settingsBtn, statusActivity } from "./shell";
import { app } from "./state";

let autoFetchTimer = 0;
export function scheduleAutoFetch() {
  clearInterval(autoFetchTimer);
  if (settings.autoFetchMinutes > 0) {
    autoFetchTimer = window.setInterval(() => {
      if (app.view && app.busy === 0 && !document.hidden) void fetchAll();
    }, settings.autoFetchMinutes * 60_000);
  }
}

/** The settings that the backend keeps in its settings file. The front end keeps a copy for the dialog.
 * An old front end kept them in the browser storage; the first start moves them to the backend. */
export async function applyBackendSettings() {
  let b: BackendSettings;
  try {
    b = await api.backendSettings();
  } catch {
    return;
  }
  const local = { gitPath: settings.gitPath, history: { days: settings.historyDays, maxMb: settings.historyMaxMb } };
  const changedLocally = local.gitPath !== "" || local.history.days !== b.history.days || local.history.maxMb !== b.history.maxMb;
  if (!b.stored && changedLocally) {
    try {
      await api.setBackendSettings({ ...local, stored: true });
      b = { ...local, stored: true };
    } catch (e) {
      toast(`The git program of the old settings does not work; git from PATH runs instead. ${String(e).replace(/^Error: /, "")}`, "error");
    }
  }
  settings.gitPath = b.gitPath;
  settings.historyDays = b.history.days;
  settings.historyMaxMb = b.history.maxMb;
  save();
}

export async function openSettings() {
  const next = await openSettingsDialog({ keymap, testGit: (p) => api.gitVersion(p), pickFile: () => pickFile("Git executable") });
  if (!next) return;
  const gitChanged = next.gitPath !== settings.gitPath;
  const backendChanged = gitChanged || next.historyDays !== settings.historyDays || next.historyMaxMb !== settings.historyMaxMb;
  if (backendChanged) {
    try {
      const version = await api.setBackendSettings({ gitPath: next.gitPath, history: { days: next.historyDays, maxMb: next.historyMaxMb }, stored: true });
      statusActivity.textContent = `git ${version}`;
    } catch (e) {
      toast(String(e).replace(/^Error: /, ""), "error");
      next.gitPath = settings.gitPath;
      next.historyDays = settings.historyDays;
      next.historyMaxMb = settings.historyMaxMb;
    }
  }
  Object.assign(settings, next);
  save();
  applyTheme();
  applyDiffSettings();
  scheduleAutoFetch();
  if (gitChanged && app.view) void refresh();
}

settingsBtn.addEventListener("click", () => void openSettings());
