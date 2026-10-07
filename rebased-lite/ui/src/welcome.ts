// The welcome screen.

import { h, icon } from "./dom";
import { askForRepo, cloneRepo, openRepo } from "./repo";
import { removeRecent, settings } from "./settings";
import { welcome, workspace } from "./shell";

export function showWorkspace(show: boolean) {
  workspace.hidden = !show;
  welcome.hidden = show;
  if (!show) renderWelcome();
}

function renderWelcome() {
  const open = h("button", { class: "primary big" }, "Open Repository…");
  open.addEventListener("click", () => void askForRepo());
  const clone = h("button", { class: "big" }, "Clone Repository…");
  clone.addEventListener("click", () => void cloneRepo());
  const recentList = h("div", { class: "recent" });
  for (const p of settings.recent) {
    const item = h("div", { class: "recent-item", title: p }, h("span", { class: "recent-name" }, p.split(/[\\/]/).pop() ?? p), h("span", { class: "recent-path" }, p));
    const remove = h("button", { class: "icon-button", title: "Remove from the list" }, icon("close"));
    remove.addEventListener("click", (e) => {
      e.stopPropagation();
      removeRecent(p);
      renderWelcome();
    });
    item.append(remove);
    item.addEventListener("click", () => void openRepo(p));
    recentList.append(item);
  }
  welcome.replaceChildren(
    h(
      "div",
      { class: "welcome-card" },
      h("div", { class: "welcome-logo" }, h("span", { class: "dot a" }), h("span", { class: "dot b" }), h("span", { class: "dot c" })),
      h("h1", {}, "Rebased Lite"),
      h("p", { class: "muted-inline" }, "A light git log viewer with the Rebased commit graph."),
      h("div", { class: "welcome-actions" }, open, clone),
      settings.recent.length ? h("div", { class: "recent-title" }, "Recent repositories") : "",
      recentList,
    ),
  );
}
