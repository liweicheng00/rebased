// Branches panel: local branches, remote branches grouped by remote, and tags.

import type { BranchInfo, RecentBranch, Submodule, Worktree } from "./api";
import { h } from "./dom";

export class Sidebar {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private search: HTMLInputElement;
  private refs: BranchInfo[] = [];
  private recent: RecentBranch[] = [];
  private worktrees: Worktree[] = [];
  private submodules: Submodule[] = [];
  private collapsed = new Set<string>(["Tags"]);
  private filterSet = new Set<string>();
  onNavigate: (b: BranchInfo) => void = () => {};
  onToggleFilter: (b: BranchInfo) => void = () => {};
  onContextMenu: (b: BranchInfo, e: MouseEvent) => void = () => {};
  onCheckout: (b: BranchInfo) => void = () => {};
  onOpenWorktree: (w: Worktree) => void = () => {};
  onWorktreeMenu: (w: Worktree, e: MouseEvent) => void = () => {};
  onAddWorktree: () => void = () => {};
  onOpenSubmodule: (s: Submodule) => void = () => {};
  onSubmoduleMenu: (s: Submodule, e: MouseEvent) => void = () => {};
  onUpdateSubmodules: () => void = () => {};

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

  setRecent(recent: RecentBranch[]) {
    this.recent = recent;
    this.render();
  }

  setWorktrees(w: Worktree[]) {
    this.worktrees = w;
    this.render();
  }

  setSubmodules(s: Submodule[]) {
    this.submodules = s;
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
    const recent = this.recent
      .filter((r) => !q || r.name.toLowerCase().includes(q))
      .map((r) => this.refs.find((b) => b.kind === "local" && b.name === r.name))
      .filter((b): b is BranchInfo => !!b);
    if (recent.length) groups.push(["Recent", recent]);
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
    this.renderWorktrees(frag);
    this.renderSubmodules(frag);
    this.list.replaceChildren(frag);
  }

  private renderWorktrees(frag: DocumentFragment) {
    const title = "Worktrees";
    const open = !this.collapsed.has(title);
    const add = h("button", { class: "icon-button group-action", title: "Add a worktree" }, "+");
    add.addEventListener("click", (e) => {
      e.stopPropagation();
      this.onAddWorktree();
    });
    const header = h(
      "div",
      { class: "group-header" },
      h("span", { class: "twisty" }, open ? "▾" : "▸"),
      h("span", {}, title),
      h("span", { class: "group-count" }, String(this.worktrees.length)),
      add,
    );
    header.addEventListener("click", () => {
      if (this.collapsed.has(title)) this.collapsed.delete(title);
      else this.collapsed.add(title);
      this.render();
    });
    frag.append(header);
    if (!open) return;
    for (const w of this.worktrees) {
      const name = w.path.split(/[\\/]/).pop() ?? w.path;
      const detail = w.branch ?? (w.detached ? `detached ${w.head?.slice(0, 8) ?? ""}` : w.bare ? "bare" : "");
      const el = h(
        "div",
        { class: "branch worktree" + (w.current ? " current" : ""), title: `${w.path}${w.locked ? "\nlocked" : ""}${w.prunable ? "\nprunable: the folder is missing" : ""}` },
        h("span", { class: "branch-icon" }, w.current ? "●" : "▣"),
        h("span", { class: "branch-name" }, name),
        h("span", { class: "worktree-branch" }, detail),
        w.prunable ? h("span", { class: "behind" }, "missing") : w.locked ? h("span", { class: "muted-inline" }, "🔒") : "",
      );
      el.addEventListener("dblclick", () => !w.current && this.onOpenWorktree(w));
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.onWorktreeMenu(w, e);
      });
      frag.append(el);
    }
  }

  /** The submodules, with their state. The section shows only when the repository has submodules. */
  private renderSubmodules(frag: DocumentFragment) {
    if (!this.submodules.length) return;
    const title = "Submodules";
    const open = !this.collapsed.has(title);
    const update = h("button", { class: "icon-button group-action", title: "Update all submodules: init, and check out the recorded commits" }, "⟳");
    update.addEventListener("click", (e) => {
      e.stopPropagation();
      this.onUpdateSubmodules();
    });
    const header = h(
      "div",
      { class: "group-header" },
      h("span", { class: "twisty" }, open ? "▾" : "▸"),
      h("span", {}, title),
      h("span", { class: "group-count" }, String(this.submodules.length)),
      update,
    );
    header.addEventListener("click", () => {
      if (this.collapsed.has(title)) this.collapsed.delete(title);
      else this.collapsed.add(title);
      this.render();
    });
    frag.append(header);
    if (!open) return;
    const stateText: Record<Submodule["state"], string> = {
      uninitialized: "not initialized",
      clean: "",
      otherCommit: "other commit",
      conflict: "conflict",
    };
    for (const s of this.submodules) {
      const commit = (s.current ?? s.recorded).slice(0, 8);
      const detail = [stateText[s.state], s.dirty ? "modified" : ""].filter(Boolean).join(", ");
      const el = h(
        "div",
        {
          class: "branch submodule",
          title: `${s.path}\nrecorded ${s.recorded}${s.current ? `\nchecked out ${s.current}` : ""}${s.url ? `\n${s.url}` : ""}`,
        },
        h("span", { class: "branch-icon" }, "⧉"),
        h("span", { class: "branch-name" }, s.path),
        h("span", { class: "worktree-branch" }, commit),
        detail ? h("span", { class: s.state === "clean" ? "muted-inline" : "behind" }, detail) : "",
      );
      el.addEventListener("dblclick", () => s.state !== "uninitialized" && this.onOpenSubmodule(s));
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.onSubmoduleMenu(s, e);
      });
      frag.append(el);
    }
  }

  private item(b: BranchInfo, label: string): HTMLElement {
    const filtered = this.filterSet.has(b.name);
    const badges = h("span", { class: "badges" });
    if (b.ahead) badges.append(h("span", { class: "ahead", title: `${b.ahead} commits ahead of ${b.upstream}` }, `↑${b.ahead}`));
    if (b.behind) badges.append(h("span", { class: "behind", title: `${b.behind} commits behind ${b.upstream}` }, `↓${b.behind}`));
    const filterBtn = h("button", { class: "filter-toggle" + (filtered ? " on" : ""), title: filtered ? "Remove from the log filter" : "Show only this branch in the log" }, "⏷");
    filterBtn.addEventListener("dblclick", (e) => e.stopPropagation());
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
    el.addEventListener("dblclick", () => (b.kind === "tag" ? this.onToggleFilter(b) : this.onCheckout(b)));
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.onContextMenu(b, e);
    });
    return el;
  }
}
