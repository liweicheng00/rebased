// The keymap actions and the key handler.

import { copyText } from "./dom";
import { showLocalHistory } from "./history-flow";
import { isMac, type KeyAction, Keymap } from "./keymap";
import { undoLast } from "./operations";
import { askForRepo, fetchAll, refresh, switchTab } from "./repo";
import { settings } from "./settings";
import { openSettings } from "./settings-flow";
import { changes, commitPanel, diff, filterBar, showLeftTab, statusRight, toggleSidebar } from "./shell";
import { app } from "./state";
import { pushBranch, updateBranch } from "./sync";

export const keymap = new Keymap();
const typing = (t: HTMLElement) => t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || !!t.closest(".monaco-editor");
const nextTab = (d: number) => {
  if (settings.tabs.length < 2) return;
  const i = settings.tabs.indexOf(settings.activeTab ?? "");
  void switchTab(settings.tabs[(i + d + settings.tabs.length) % settings.tabs.length]);
};
for (const a of [
  { id: "open", label: "Open Repository", defaults: ["Mod+O"], run: () => void askForRepo() },
  { id: "refresh", label: "Refresh", defaults: ["Mod+R", "F5"], run: () => void refresh() },
  { id: "fetch", label: "Fetch", defaults: [], run: () => app.view && void fetchAll() },
  { id: "update", label: "Update the Current Branch", defaults: ["Mod+T"], run: () => app.view && void updateBranch() },
  { id: "push", label: "Push", defaults: ["Mod+Shift+K"], run: () => app.view && void pushBranch() },
  {
    id: "commit",
    label: "Commit (show the Commit tab)",
    defaults: ["Mod+K"],
    run: () => {
      showLeftTab("commit");
      commitPanel.focusMessage();
    },
  },
  { id: "undo", label: "Undo the Last Operation", defaults: ["Mod+Z"], run: () => app.view && void undoLast(), when: (t: HTMLElement) => !typing(t) },
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
  { id: "localHistory", label: "Local History", defaults: [], run: () => app.view && showLocalHistory("") },
  { id: "nextTab", label: "Next Tab", defaults: ["Mod+PageDown"], run: () => nextTab(1) },
  { id: "previousTab", label: "Previous Tab", defaults: ["Mod+PageUp"], run: () => nextTab(-1) },
  { id: "nextChange", label: "Next Change in the Diff", defaults: ["F7"], run: () => diff.goToDiff("next") },
  { id: "previousChange", label: "Previous Change in the Diff", defaults: ["Shift+F7"], run: () => diff.goToDiff("previous") },
  { id: "nextFile", label: "Next File", defaults: ["Alt+ArrowDown"], run: () => (app.diffSource === "local" ? commitPanel.move(1) : changes.move(1)) },
  { id: "previousFile", label: "Previous File", defaults: ["Alt+ArrowUp"], run: () => (app.diffSource === "local" ? commitPanel.move(-1) : changes.move(-1)) },
  {
    id: "copyHash",
    label: "Copy the Revision Number",
    defaults: ["Mod+C"],
    run: () => {
      void copyText(app.selected.map((s) => s.oid).join(" "));
      statusRight.textContent = "Copied the revision number";
    },
    when: (t: HTMLElement) => !typing(t) && !!t.closest(".log") && app.selected.length > 0,
  },
  { id: "settings", label: "Settings", defaults: [isMac ? "Mod+Comma" : "Mod+Alt+S"], run: () => void openSettings() },
] as KeyAction[]) keymap.add(a);
