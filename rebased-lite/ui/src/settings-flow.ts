// The Settings dialog and the settings that the backend needs.

import { api, pickFile } from "./api";
import { applyDiffSettings } from "./diff-view";
import { keymap } from "./keyboard";
import { toast } from "./notify";
import { fetchAll, refresh } from "./repo";
import { save, settings } from "./settings";
import { openSettingsDialog } from "./settings-dialog";
import { applyTheme, settingsBtn, statusRight } from "./shell";
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

/** Applies the settings that live outside the front end: the git program and the Local History limits. */
export async function applyBackendSettings() {
  if (settings.gitPath) {
    try {
      await api.setGitProgram(settings.gitPath);
    } catch (e) {
      toast(`The git program in the settings does not work; git from PATH runs instead. ${String(e).replace(/^Error: /, "")}`, "error");
    }
  }
  await api.setLocalHistoryLimits(settings.historyDays, settings.historyMaxMb).catch(() => {});
}

export async function openSettings() {
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
  if (gitChanged && app.view) void refresh();
}

window.addEventListener("keydown", (e) => {
  // An open dialog handles its own keys.
  if (document.querySelector(".overlay, .merge-overlay")) return;
  keymap.handle(e);
});

settingsBtn.addEventListener("click", () => void openSettings());
