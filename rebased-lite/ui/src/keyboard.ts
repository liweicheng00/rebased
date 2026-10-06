// The keymap actions and the key handler.

import { copyText } from "./dom";
import { openInEditorHere } from "./editor-flow";
import { showLocalHistory } from "./history-flow";
import { isMac, type KeyAction, Keymap } from "./keymap";
import { undoLast } from "./operations";
import { askForRepo, fetchAll, refresh, switchTab } from "./repo";
import { settings } from "./settings";
import { openSettings } from "./settings-flow";
import { changes, commitPanel, diff, filterBar, openBtn, showLeftTab, statusActivity, toggleDiff, toggleSidebar } from "./shell";
import { app } from "./state";
import { pushBranch, updateBranch } from "./sync";
import { resetZoom, zoomBy } from "./zoom";

export const keymap = new Keymap();
const typing = (t: HTMLElement) => t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || !!t.closest(".monaco-editor");
/** The next open project, as Cmd+` in macOS. With one project open, the Open menu shows the recent ones. */
const switchProject = (d: number) => {
  if (settings.tabs.length < 2) return openBtn.click();
  nextTab(d);
};
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
    label: "Changes Tab (and the commit message)",
    defaults: ["Mod+2", "Mod+K"],
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
  { id: "stash", label: "Stash Tab", defaults: ["Mod+3"], run: () => showLeftTab("stash") },
  { id: "reviews", label: "Reviews Tab", defaults: ["Mod+4"], run: () => showLeftTab("reviews") },
  { id: "diffPanel", label: "Diff Panel (show or hide)", defaults: [], run: () => toggleDiff() },
  { id: "hideDiff", label: "Hide the Diff Panel", defaults: ["Escape"], run: () => toggleDiff(false), when: (t: HTMLElement) => !typing(t) && settings.showDiff },
  { id: "switchProject", label: "Switch Project", defaults: ["Mod+`"], run: () => switchProject(1) },
  { id: "switchProjectBack", label: "Switch Project (back)", defaults: ["Mod+Shift+`"], run: () => switchProject(-1) },
  { id: "openInEditor", label: "Open in Editor", defaults: ["F4"], run: (t: HTMLElement) => app.view && openInEditorHere(t) },
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
      statusActivity.textContent = "Copied the revision number";
    },
    when: (t: HTMLElement) => !typing(t) && !!t.closest(".log") && app.selected.length > 0,
  },
  { id: "zoomIn", label: "Zoom In", defaults: ["Mod+=", "Mod+Shift+="], run: () => zoomBy(1) },
  { id: "zoomOut", label: "Zoom Out", defaults: ["Mod+-"], run: () => zoomBy(-1) },
  { id: "zoomReset", label: "Actual Size", defaults: ["Mod+0"], run: () => resetZoom() },
  { id: "settings", label: "Settings", defaults: [isMac ? "Mod+Comma" : "Mod+Alt+S"], run: () => void openSettings() },
] as KeyAction[]) keymap.add(a);

/** The dialogs and windows that were open when the key came. A window can close on the key (Esc) before
 * the handler below runs; the key still belongs to that window then. The capture phase of the window
 * comes before all other handlers. */
let openAtKey = { dialog: false, window: false };
window.addEventListener("keydown", () => (openAtKey = { dialog: !!document.querySelector(".overlay"), window: !!document.querySelector(".merge-overlay") }), true);

window.addEventListener("keydown", (e) => {
  // An open dialog handles its own keys. A window, such as Compare or Review, takes Open in Editor only.
  if (openAtKey.dialog || document.querySelector(".overlay")) return;
  // The zoom keys work in every window, as in a browser.
  if (keymap.handle(e, (a) => a.id.startsWith("zoom"))) return;
  if (openAtKey.window || document.querySelector(".merge-overlay")) return void keymap.handle(e, (a) => a.id === "openInEditor");
  keymap.handle(e);
});
