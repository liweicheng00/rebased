// Changed files between two revisions, as a flat list or a directory tree.

import type { Change } from "./api";
import { h } from "./dom";
import { save, settings } from "./settings";

interface Dir {
  name: string;
  dirs: Map<string, Dir>;
  files: { change: Change; index: number }[];
}

export class ChangesPanel {
  readonly el: HTMLElement;
  private title: HTMLElement;
  private count: HTMLElement;
  private list: HTMLElement;
  private treeBtn: HTMLButtonElement;
  private changes: Change[] = [];
  private active = -1;
  private collapsed = new Set<string>();
  onOpen: (index: number) => void = () => {};
  onContextMenu: (change: Change, e: MouseEvent) => void = () => {};
  onSwap: () => void = () => {};

  constructor() {
    this.title = h("span", { class: "changes-title" }, "Changes");
    this.count = h("span", { class: "changes-count" });
    this.treeBtn = h("button", { class: "icon-button", title: "Show as tree or flat list" });
    this.treeBtn.addEventListener("click", () => {
      settings.changesAsTree = !settings.changesAsTree;
      save();
      this.render();
    });
    const swap = h("button", { class: "icon-button", title: "Swap left and right sides" }, "⇄");
    swap.addEventListener("click", () => this.onSwap());
    this.list = h("div", { class: "changes", tabIndex: 0 });
    this.list.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      this.move(e.key === "ArrowDown" ? 1 : -1);
    });
    this.el = h(
      "section",
      { class: "changes-panel" },
      h("div", { class: "pane-title" }, this.title, this.count, h("span", { class: "spacer" }), this.treeBtn, swap),
      this.list,
    );
    this.setMessage("Select a commit to see its changes.");
  }

  setTitle(text: string) {
    this.title.textContent = text;
  }

  setMessage(text: string) {
    this.changes = [];
    this.active = -1;
    this.count.textContent = "";
    this.list.replaceChildren(h("div", { class: "muted" }, text));
  }

  setChanges(changes: Change[]) {
    this.changes = changes;
    this.active = -1;
    this.collapsed.clear();
    this.count.textContent = `${changes.length} file${changes.length === 1 ? "" : "s"}`;
    this.render();
  }

  setActive(i: number) {
    this.active = i;
    for (const el of this.list.querySelectorAll(".change")) {
      el.classList.toggle("active", Number((el as HTMLElement).dataset.index) === i);
    }
    this.list.querySelector(".change.active")?.scrollIntoView({ block: "nearest" });
  }

  get size() {
    return this.changes.length;
  }

  /** Moves to the next or previous file in display order. */
  move(delta: number) {
    const order = [...this.list.querySelectorAll<HTMLElement>(".change")].map((e) => Number(e.dataset.index));
    if (!order.length) return;
    const pos = order.indexOf(this.active);
    const next = order[Math.max(0, Math.min(order.length - 1, pos < 0 ? 0 : pos + delta))];
    if (next !== this.active) this.onOpen(next);
  }

  firstInOrder(): number {
    const first = this.list.querySelector<HTMLElement>(".change");
    return first ? Number(first.dataset.index) : -1;
  }

  private render() {
    this.treeBtn.textContent = settings.changesAsTree ? "☰" : "🗀";
    this.treeBtn.title = settings.changesAsTree ? "Show as a flat list" : "Group by directory";
    if (!this.changes.length) {
      this.list.replaceChildren(h("div", { class: "muted" }, "No changes."));
      return;
    }
    const frag = document.createDocumentFragment();
    if (!settings.changesAsTree) {
      this.changes.forEach((c, i) => frag.append(this.file(c, i, 0, true)));
    } else {
      const root: Dir = { name: "", dirs: new Map(), files: [] };
      this.changes.forEach((change, index) => {
        const parts = change.path.split("/");
        let d = root;
        for (const p of parts.slice(0, -1)) {
          if (!d.dirs.has(p)) d.dirs.set(p, { name: p, dirs: new Map(), files: [] });
          d = d.dirs.get(p)!;
        }
        d.files.push({ change, index });
      });
      this.renderDir(root, "", 0, frag);
    }
    this.list.replaceChildren(frag);
    this.setActive(this.active);
  }

  private renderDir(d: Dir, path: string, depth: number, out: DocumentFragment) {
    for (const [name, sub] of [...d.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      // Join single-child directory chains, like IntelliJ.
      let label = name;
      let node = sub;
      while (node.files.length === 0 && node.dirs.size === 1) {
        const [n, s] = [...node.dirs][0];
        label += "/" + n;
        node = s;
      }
      const full = path + label + "/";
      const open = !this.collapsed.has(full);
      const count = countFiles(node);
      const row = h(
        "div",
        { class: "dir-row", style: { paddingLeft: `${8 + depth * 14}px` } },
        h("span", { class: "twisty" }, open ? "▾" : "▸"),
        h("span", { class: "dir-name" }, label),
        h("span", { class: "dir-count" }, String(count)),
      );
      row.addEventListener("click", () => {
        if (open) this.collapsed.add(full);
        else this.collapsed.delete(full);
        this.render();
      });
      out.append(row);
      if (open) this.renderDir(node, full, depth + 1, out);
    }
    for (const f of d.files) out.append(this.file(f.change, f.index, depth, false));
  }

  private file(c: Change, i: number, depth: number, withDir: boolean): HTMLElement {
    const slash = c.path.lastIndexOf("/");
    const item = h(
      "div",
      { class: "change", "data-index": i, style: { paddingLeft: `${8 + depth * 14 + (withDir ? 0 : 14)}px` } },
      h("span", { class: `status status-${c.status}`, title: statusName(c.status) }, c.status),
      h("span", { class: `path status-text-${c.status}` }, c.path.slice(slash + 1)),
      c.old_path ? h("span", { class: "dir" }, `← ${c.old_path}`) : withDir && slash > 0 ? h("span", { class: "dir" }, c.path.slice(0, slash)) : "",
    );
    item.title = c.old_path ? `${c.old_path} → ${c.path}` : c.path;
    item.addEventListener("click", () => this.onOpen(i));
    item.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.onContextMenu(c, e);
    });
    return item;
  }
}

function countFiles(d: Dir): number {
  let n = d.files.length;
  for (const s of d.dirs.values()) n += countFiles(s);
  return n;
}

export function statusName(s: string): string {
  return ({ A: "Added", M: "Modified", D: "Deleted", R: "Renamed", C: "Copied", T: "Type changed" } as Record<string, string>)[s] ?? s;
}
