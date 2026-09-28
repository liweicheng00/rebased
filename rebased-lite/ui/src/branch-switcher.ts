// The branch popup in the toolbar: recent branches first, then local and remote branches, with a search box.

import type { BranchInfo, RecentBranch } from "./api";
import { closeMenu } from "./context-menu";
import { h } from "./dom";

export function showBranchSwitcher(
  anchor: HTMLElement,
  refs: BranchInfo[],
  recent: RecentBranch[],
  actions: { checkout: (b: BranchInfo) => void; newBranch: () => void; menu: (b: BranchInfo, e: MouseEvent) => void },
) {
  closeMenu();
  document.querySelector(".switcher")?.remove();
  const search = h("input", { class: "switcher-search", placeholder: "Search branches", spellcheck: false });
  const list = h("div", { class: "switcher-list" });
  const newBtn = h("button", { class: "switcher-new" }, "＋ New Branch…");
  const pop = h("div", { class: "switcher menu" }, search, newBtn, list);
  const close = () => {
    pop.remove();
    window.removeEventListener("mousedown", outside, true);
  };
  const outside = (e: MouseEvent) => !pop.contains(e.target as Node) && e.target !== anchor && close();
  newBtn.addEventListener("click", () => {
    close();
    actions.newBranch();
  });
  const render = () => {
    const q = search.value.trim().toLowerCase();
    const match = (n: string) => !q || n.toLowerCase().includes(q);
    const locals = refs.filter((b) => b.kind === "local");
    const recentRefs = recent.map((r) => locals.find((b) => b.name === r.name)).filter((b): b is BranchInfo => !!b && match(b.name));
    const sections: [string, BranchInfo[]][] = [
      ["Recent", recentRefs],
      ["Local", locals.filter((b) => match(b.name))],
      ["Remote", refs.filter((b) => b.kind === "remote" && match(b.name))],
    ];
    const frag = document.createDocumentFragment();
    for (const [title, items] of sections) {
      if (!items.length) continue;
      frag.append(h("div", { class: "menu-header" }, title));
      for (const b of items.slice(0, 80)) {
        const el = h(
          "button",
          { class: "menu-item" + (b.current ? " current" : ""), title: b.subject },
          h("span", { class: "menu-check" }, b.current ? "★" : ""),
          h("span", { class: "menu-label" }, b.name),
          h("span", { class: "menu-shortcut" }, b.ahead || b.behind ? `${b.ahead ? `↑${b.ahead}` : ""}${b.behind ? ` ↓${b.behind}` : ""}` : ""),
        );
        el.addEventListener("click", () => {
          close();
          if (!b.current) actions.checkout(b);
        });
        el.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          close();
          actions.menu(b, e);
        });
        frag.append(el);
      }
    }
    if (!frag.childNodes.length) frag.append(h("div", { class: "muted" }, "No branches match."));
    list.replaceChildren(frag);
  };
  search.addEventListener("input", render);
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
    if (e.key === "Enter") (list.querySelector(".menu-item:not(.current)") as HTMLElement | null)?.click();
  });
  render();
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - pop.offsetWidth - 4))}px`;
  pop.style.top = `${r.bottom + 2}px`;
  setTimeout(() => window.addEventListener("mousedown", outside, true));
  search.focus();
}
