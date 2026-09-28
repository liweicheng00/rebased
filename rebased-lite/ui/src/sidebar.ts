// Branches panel: local branches, remote branches grouped by remote, and tags.

import type { BranchInfo } from "./api";
import { h } from "./dom";

export class Sidebar {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private search: HTMLInputElement;
  private refs: BranchInfo[] = [];
  private collapsed = new Set<string>(["Tags"]);
  private filterSet = new Set<string>();
  onNavigate: (b: BranchInfo) => void = () => {};
  onToggleFilter: (b: BranchInfo) => void = () => {};
  onContextMenu: (b: BranchInfo, e: MouseEvent) => void = () => {};

  constructor() {
    this.search = h("input", { class: "sidebar-search", placeholder: "Search branches and tags", spellcheck: false });
    this.search.addEventListener("input", () => this.render());
    this.list = h("div", { class: "sidebar-list" });
    this.el = h("aside", { class: "sidebar" }, h("div", { class: "pane-title" }, "Branches"), this.search, this.list);
  }

  setRefs(refs: BranchInfo[]) {
    this.refs = refs;
    this.render();
  }

  setFilter(names: string[]) {
    this.filterSet = new Set(names);
    this.render();
  }

  private render() {
    const q = this.search.value.trim().toLowerCase();
    const match = (b: BranchInfo) => !q || b.name.toLowerCase().includes(q);
    const groups: [string, BranchInfo[]][] = [];
    const current = this.refs.filter((b) => b.current);
    const locals = this.refs.filter((b) => b.kind === "local" && match(b));
    groups.push(["Local", locals]);
    const remotes = new Map<string, BranchInfo[]>();
    for (const b of this.refs.filter((b) => b.kind === "remote" && match(b))) {
      const remote = b.name.split("/")[0];
      if (!remotes.has(remote)) remotes.set(remote, []);
      remotes.get(remote)!.push(b);
    }
    for (const [remote, list] of remotes) groups.push([`Remote: ${remote}`, list]);
    groups.push(["Tags", this.refs.filter((b) => b.kind === "tag" && match(b)).reverse()]);

    const frag = document.createDocumentFragment();
    if (current.length) {
      const c = current[0];
      frag.append(h("div", { class: "sidebar-head", title: c.subject }, h("span", { class: "head-icon" }, "HEAD"), " ", c.name));
    }
    for (const [title, items] of groups) {
      if (!items.length) continue;
      const open = q ? true : !this.collapsed.has(title);
      const header = h(
        "div",
        { class: "group-header" },
        h("span", { class: "twisty" }, open ? "▾" : "▸"),
        h("span", {}, title),
        h("span", { class: "group-count" }, String(items.length)),
      );
      header.addEventListener("click", () => {
        if (this.collapsed.has(title)) this.collapsed.delete(title);
        else this.collapsed.add(title);
        this.render();
      });
      frag.append(header);
      if (!open) continue;
      for (const b of items) frag.append(this.item(b, title.startsWith("Remote") ? b.name.slice(b.name.indexOf("/") + 1) : b.name));
    }
    if (!frag.childNodes.length) frag.append(h("div", { class: "muted" }, "No branches."));
    this.list.replaceChildren(frag);
  }

  private item(b: BranchInfo, label: string): HTMLElement {
    const filtered = this.filterSet.has(b.name);
    const badges = h("span", { class: "badges" });
    if (b.ahead) badges.append(h("span", { class: "ahead", title: `${b.ahead} commits ahead of ${b.upstream}` }, `↑${b.ahead}`));
    if (b.behind) badges.append(h("span", { class: "behind", title: `${b.behind} commits behind ${b.upstream}` }, `↓${b.behind}`));
    const filterBtn = h("button", { class: "filter-toggle" + (filtered ? " on" : ""), title: filtered ? "Remove from the log filter" : "Show only this branch in the log" }, "⏷");
    filterBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.onToggleFilter(b);
    });
    const el = h(
      "div",
      { class: `branch branch-${b.kind}` + (b.current ? " current" : "") + (filtered ? " filtered" : ""), title: `${b.name}\n${b.subject}` },
      h("span", { class: "branch-icon" }, b.kind === "tag" ? "⌗" : b.current ? "★" : "⑂"),
      h("span", { class: "branch-name" }, label),
      badges,
      filterBtn,
    );
    el.addEventListener("click", () => this.onNavigate(b));
    el.addEventListener("dblclick", () => this.onToggleFilter(b));
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.onContextMenu(b, e);
    });
    return el;
  }
}
