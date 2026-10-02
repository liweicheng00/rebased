// Rebased Lite: the start of the front end. The modules register their handlers when they load.

import "./style.css";
// Each module registers its handlers when it loads; the shell comes first.
import "./shell";
import "./repo";
import "./watch";
import "./selection";
import "./operations";
import "./commit-flow";
import "./sync";
import "./stash-flow";
import "./review-flow";
import "./history-flow";
import "./conflicts";
import "./menus";
import "./remotes";
import "./welcome";
import "./keyboard";
import "./settings-flow";
import { initialPath } from "./api";
import { openRepo, renderTabs, switchTab } from "./repo";
import { settings } from "./settings";
import { applyBackendSettings, scheduleAutoFetch } from "./settings-flow";
import { applyLayout, applyTheme, showLeftTab } from "./shell";
import { showWorkspace } from "./welcome";

// No spell check, autocorrect or automatic capitals in the fields: branch names, paths and hashes are
// not prose. The attributes go on each field when it gets the focus, so fields made later get them too.
document.documentElement.spellcheck = false;
document.addEventListener(
  "focusin",
  (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement)) return;
    t.spellcheck = false;
    for (const a of ["autocorrect", "autocapitalize", "autocomplete"]) t.setAttribute(a, "off");
  },
  true,
);
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
