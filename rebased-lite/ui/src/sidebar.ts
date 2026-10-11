// Branches panel: local branches, remote branches grouped by remote, and tags.

import type { BranchInfo, RecentBranch, Submodule, Worktree } from "./api";
import { compareTags } from "./version-sort";
import { h, icon, twisty } from "./dom";

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
  /** Favorite branches and tags, by full ref name. */
  private favorites = new Set<string>();
  private onlyFavorites = false;
  /** Branches with a prefix ("feature/a") show in a folder of the prefix, as IntelliJ's Group by Directory. */
  private groupByPrefix = false;
  private favBtn: HTMLButtonElement;
  onToggleFavorite: (b: BranchInfo) => void = () => {};
  onNavigate: (b: BranchInfo) => void = () => {};
  onToggleFilter: (b: BranchInfo) => void = () => {};
  onContextMenu: (b: BranchInfo, e: MouseEvent) => void = () => {};
  /** The context menu of a multiple selection: two or more branches and tags. */
  onMultiMenu: (refs: BranchInfo[], e: MouseEvent) => void = () => {};
  /** The selected branches and tags, by full ref name. Ctrl+click and Shift+click select more than one. */
  private selection = new Set<string>();
  private anchor: string | null = null;
  onCheckout: (b: BranchInfo) => void = () => {};
  onOpenWorktree: (w: Worktree) => void = () => {};
  onWorktreeMenu: (w: Worktree, e: MouseEvent) => void = () => {};
  onAddWorktree: () => void = () => {};
  onOpenSubmodule: (s: Submodule) => void = () => {};
  onSubmoduleMenu: (s: Submodule, e: MouseEvent) => void = () => {};
  onUpdateSubmodules: () => void = () => {};
  /** The context menu of a remote group. */
  onRemoteMenu: (remote: string, e: MouseEvent) => void = () => {};
  /** The context menu of the Local group header. */
  onLocalMenu: (e: MouseEvent) => void = () => {};
  /** The context menu of the Tags group header. */
  onTagsMenu: (e: MouseEvent) => void = () => {};
  /** The tags of a remote, after a fetch or a check. Null: not known, so no tag shows as local only. */
  private remoteTags: { remote: string; names: Set<string> } | null = null;

  constructor() {
    this.search = h("input", { class: "sidebar-search", placeholder: "Search branches and tags", spellcheck: false });
    this.search.addEventListener("input", () => this.render());
    this.list = h("div", { class: "sidebar-list" });
    this.favBtn = h("button", { class: "icon-button fav-filter", title: "Show only the favorite branches" }, icon("star"));
    this.favBtn.addEventListener("click", () => {
      this.onlyFavorites = !this.onlyFavorites;
      this.favBtn.classList.toggle("on", this.onlyFavorites);
      this.render();
    });
    this.el = h("aside", { class: "sidebar" }, h("div", { class: "pane-title" }, "Branches"), h("div", { class: "sidebar-search-row" }, this.search, this.favBtn), this.list);
  }

  setGroupByPrefix(on: boolean) {
    this.groupByPrefix = on;
    this.render();
  }

  setRefs(refs: BranchInfo[]) {
    this.refs = refs;
    const known = new Set(refs.map((b) => b.full));
    this.selection = new Set([...this.selection].filter((f) => known.has(f)));
    this.render();
  }

  setRemoteTags(remote: string | null, names: string[] | null) {
    this.remoteTags = remote && names ? { remote, names: new Set(names) } : null;
    this.render();
  }

  /** The remote of the last check of the tags, or null. */
  get remoteTagsOf(): string | null {
    return this.remoteTags?.remote ?? null;
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

  setFavorites(full: Iterable<string>) {
    this.favorites = new Set(full);
    this.render();
  }

  isFavorite(b: BranchInfo): boolean {
    return this.favorites.has(b.full);
  }

  setFilter(names: string[]) {
    this.filterSet = new Set(names);
    this.render();
  }

  /** The selected branches and tags, in the order of the list. */
  get selected(): BranchInfo[] {
    return this.refs.filter((b) => this.selection.has(b.full));
  }

  clearSelection() {
    this.selection.clear();
    this.paintSelection();
  }

  private paintSelection() {
    for (const el of this.list.querySelectorAll<HTMLElement>(".branch[data-ref]")) el.classList.toggle("selected", this.selection.has(el.dataset.ref!));
  }

  /** Selects with the modifier keys of a click: Ctrl or Cmd adds or removes one, Shift adds a range. */
  private clickSelect(b: BranchInfo, e: MouseEvent): boolean {
    if (e.shiftKey && this.anchor) {
      const order = [...new Set([...this.list.querySelectorAll<HTMLElement>(".branch[data-ref]")].map((el) => el.dataset.ref!))];
      const [i, j] = [order.indexOf(this.anchor), order.indexOf(b.full)];
      if (i >= 0 && j >= 0) {
        if (!(e.ctrlKey || e.metaKey)) this.selection.clear();
        for (const f of order.slice(Math.min(i, j), Math.max(i, j) + 1)) this.selection.add(f);
        this.paintSelection();
        return true;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      if (this.selection.has(b.full)) this.selection.delete(b.full);
      else this.selection.add(b.full);
      this.anchor = b.full;
      this.paintSelection();
      return true;
    }
    this.selection = new Set([b.full]);
    this.anchor = b.full;
    this.paintSelection();
    return false;
  }

  private render() {
    const q = this.search.value.trim().toLowerCase();
    const match = (b: BranchInfo) => (!q || b.name.toLowerCase().includes(q)) && (!this.onlyFavorites || b.current || this.favorites.has(b.full));
    const groups: [string, BranchInfo[]][] = [];
    const current = this.refs.filter((b) => b.current);
    const recent = this.recent
      .map((r) => this.refs.find((b) => b.kind === "local" && b.name === r.name))
      .filter((b): b is BranchInfo => !!b && match(b));
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
    groups.push(["Tags", this.refs.filter((b) => b.kind === "tag" && match(b)).sort((a, b) => compareTags(a.name, b.name))]);

    const frag = document.createDocumentFragment();
    if (current.length) {
      const c = current[0];
      const head = h("div", { class: "sidebar-head", title: `${c.subject}\nClick: go to the commit of HEAD` }, h("span", { class: "head-icon" }, "HEAD"), " ", c.name);
      head.addEventListener("click", () => this.onNavigate(c));
      head.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.onContextMenu(c, e);
      });
      frag.append(head);
    }
    for (const [title, unsorted] of groups) {
      // Favorites first, as in IntelliJ; the order stays otherwise.
      const items = [...unsorted.filter((b) => this.favorites.has(b.full)), ...unsorted.filter((b) => !this.favorites.has(b.full))];
      if (!items.length) continue;
      const open = q ? true : !this.collapsed.has(title);
      const header = h(
        "div",
        { class: "group-header" },
        twisty(open),
        h("span", {}, title),
        h("span", { class: "group-count" }, String(items.length)),
      );
      header.addEventListener("click", () => {
        if (this.collapsed.has(title)) this.collapsed.delete(title);
        else this.collapsed.add(title);
        this.render();
      });
      if (title === "Tags") {
        header.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          this.onTagsMenu(e);
        });
      }
      if (title === "Local") {
        header.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          this.onLocalMenu(e);
        });
      }
      if (title.startsWith("Remote: ")) {
        header.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          this.onRemoteMenu(title.slice("Remote: ".length), e);
        });
      }
      frag.append(header);
      if (!open) continue;
      const label = (b: BranchInfo) => (title.startsWith("Remote") ? b.name.slice(b.name.indexOf("/") + 1) : b.name);
      if (this.groupByPrefix && !q && (title === "Local" || title.startsWith("Remote: "))) this.renderFolders(frag, title, items, label);
      else for (const b of items) frag.append(this.item(b, label(b)));
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
      twisty(open),
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
        h("span", { class: "branch-icon" + (w.current ? " current" : "") }, icon("worktree")),
        h("span", { class: "branch-name" }, name),
        h("span", { class: "worktree-branch" }, detail),
        w.prunable ? h("span", { class: "behind" }, "missing") : w.locked ? h("span", { class: "muted-inline", title: "Locked" }, icon("lock")) : "",
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
    const update = h("button", { class: "icon-button group-action", title: "Update all submodules: init, and checkout the recorded commits" }, icon("refresh"));
    update.addEventListener("click", (e) => {
      e.stopPropagation();
      this.onUpdateSubmodules();
    });
    const header = h(
      "div",
      { class: "group-header" },
      twisty(open),
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
        h("span", { class: "branch-icon" }, icon("submodule")),
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

  /** The branches of a group in folders of their prefixes. A folder opens and closes with a click. */
  private renderFolders(frag: DocumentFragment, group: string, items: BranchInfo[], label: (b: BranchInfo) => string) {
    interface Folder {
      dirs: Map<string, Folder>;
      branches: BranchInfo[];
      count: number;
    }
    const root: Folder = { dirs: new Map(), branches: [], count: 0 };
    for (const b of items) {
      const parts = label(b).split("/");
      let f = root;
      f.count++;
      for (const p of parts.slice(0, -1)) {
        if (!f.dirs.has(p)) f.dirs.set(p, { dirs: new Map(), branches: [], count: 0 });
        f = f.dirs.get(p)!;
        f.count++;
      }
      f.branches.push(b);
    }
    const walk = (f: Folder, path: string, depth: number) => {
      for (const [name, sub] of [...f.dirs].sort(([a], [b]) => a.localeCompare(b))) {
        const key = `${group}\0${path}${name}/`;
        const open = !this.collapsed.has(key);
        const row = h(
          "div",
          { class: "branch-folder", style: { paddingLeft: `${8 + depth * 14}px` }, title: `${path}${name}/` },
          twisty(open),
          icon("folder"),
          h("span", { class: "branch-name" }, name),
          h("span", { class: "group-count" }, String(sub.count)),
        );
        row.addEventListener("click", () => {
          if (open) this.collapsed.add(key);
          else this.collapsed.delete(key);
          this.render();
        });
        frag.append(row);
        if (open) walk(sub, `${path}${name}/`, depth + 1);
      }
      for (const b of f.branches) {
        const el = this.item(b, label(b).split("/").pop()!);
        el.style.paddingLeft = `${22 + depth * 14}px`;
        frag.append(el);
      }
    };
    walk(root, "", 0);
  }

  private item(b: BranchInfo, label: string): HTMLElement {
    const filtered = this.filterSet.has(b.name);
    const badges = h("span", { class: "badges" });
    if (b.ahead) badges.append(h("span", { class: "ahead", title: `${b.ahead} commits ahead of ${b.upstream}` }, `↑${b.ahead}`));
    if (b.behind) badges.append(h("span", { class: "behind", title: `${b.behind} commits behind ${b.upstream}` }, `↓${b.behind}`));
    if (b.kind === "tag" && this.remoteTags && !this.remoteTags.names.has(b.name)) {
      badges.append(h("span", { class: "tag-local", title: `Not on ${this.remoteTags.remote}. Push it from the context menu.` }, "local"));
    }
    const filterBtn = h("button", { class: "filter-toggle" + (filtered ? " on" : ""), title: filtered ? "Remove from the log filter" : "Show only this branch in the log" }, icon("filter"));
    filterBtn.addEventListener("dblclick", (e) => e.stopPropagation());
    filterBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.onToggleFilter(b);
    });
    const fav = this.favorites.has(b.full);
    const favBtn = h("button", { class: "fav-toggle" + (fav ? " on" : ""), title: fav ? "Remove from favorites" : "Add to favorites" }, icon(fav ? "star-filled" : "star"));
    favBtn.addEventListener("dblclick", (e) => e.stopPropagation());
    favBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.onToggleFavorite(b);
    });
    const el = h(
      "div",
      {
        class: `branch branch-${b.kind}` + (b.current ? " current" : "") + (filtered ? " filtered" : "") + (fav ? " favorite" : "") + (this.selection.has(b.full) ? " selected" : ""),
        "data-ref": b.full,
        title: `${b.name}\n${b.subject}\nCtrl+click or Shift+click: select more than one`,
      },
      h("span", { class: "branch-icon", title: b.current ? "The current branch" : "" }, icon(b.kind === "tag" ? "tag" : b.current ? "current" : "branch")),
      h("span", { class: "branch-name" }, label),
      badges,
      favBtn,
      filterBtn,
    );
    // A press with Shift does not select the text of the list.
    el.addEventListener("mousedown", (e) => e.shiftKey && e.preventDefault());
    el.addEventListener("click", (e) => {
      if (!this.clickSelect(b, e)) this.onNavigate(b);
    });
    el.addEventListener("dblclick", (e) => !(e.ctrlKey || e.metaKey || e.shiftKey) && (b.kind === "tag" ? this.onToggleFilter(b) : this.onCheckout(b)));
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (!this.selection.has(b.full)) {
        this.selection = new Set([b.full]);
        this.anchor = b.full;
        this.paintSelection();
      }
      const refs = this.selected;
      if (refs.length > 1) this.onMultiMenu(refs, e);
      else this.onContextMenu(b, e);
    });
    return el;
  }
}
