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
