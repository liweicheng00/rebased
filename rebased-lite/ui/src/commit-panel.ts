// Commit panel: local changes grouped by changelist, as in IntelliJ's Commit tool window.
// The checked files go into the commit. By default the files of the active changelist are checked.

import type { Change, ChangeListView, LocalChanges } from "./api";
import { statusName } from "./changes-panel";
import { h } from "./dom";

/** A file row: a tracked change in a changelist, or an unversioned file. */
export interface LocalFile {
  key: string;
  change: Change;
  /** The changelist id, or null for an unversioned file. */
  list: string | null;
}

const UNVERSIONED = "Unversioned Files";

export class CommitPanel {
  readonly el: HTMLElement;
  private tree: HTMLElement;
  private message: HTMLTextAreaElement;
  private amend: HTMLInputElement;
  private commitBtn: HTMLButtonElement;
  private pushBtn: HTMLButtonElement;
  private summary: HTMLElement;
  private data: LocalChanges | null = null;
  private files: LocalFile[] = [];
  private included = new Set<string>();
  /** Files with unchecked changes: the excluded change ids and the content to commit. */
  private partial = new Map<string, { excluded: Set<string>; content: string }>();
  private seen = new Set<string>();
  private selection = new Set<string>();
  private anchor: string | null = null;
  private activeKey: string | null = null;
  private collapsed = new Set<string>();
  /** The changelist whose draft message is in the message field. */
  private target: string | null = null;
  private saveTimer = 0;
  private draftBeforeAmend = "";

  onOpen: (f: LocalFile) => void = () => {};
  onFileMenu: (files: LocalFile[], e: MouseEvent) => void = () => {};
  onListMenu: (list: ChangeListView, e: MouseEvent) => void = () => {};
  onUnversionedMenu: (e: MouseEvent) => void = () => {};
  onMove: (paths: string[], to: string) => void = () => {};
  onCommit: (files: LocalFile[], message: string, amend: boolean, list: string | null, push: boolean) => void = () => {};
  onSaveMessage: (list: string, message: string) => void = () => {};
  onAmendToggle: (on: boolean) => Promise<string> = async () => "";
  onRefresh: () => void = () => {};
  onRollback: (files: LocalFile[]) => void = () => {};
  onNewChangeList: () => void = () => {};

  constructor() {
    const refresh = h("button", { class: "icon-button", title: "Refresh the local changes" }, "⟳");
    refresh.addEventListener("click", () => this.onRefresh());
    const rollback = h("button", { class: "icon-button", title: "Roll back the selected files" }, "↶");
    rollback.addEventListener("click", () => {
      const sel = this.selectedFiles().filter((f) => f.list !== null);
      if (sel.length) this.onRollback(sel);
    });
    const newList = h("button", { class: "icon-button", title: "New changelist" }, "＋");
    newList.addEventListener("click", () => this.onNewChangeList());
    const expand = h("button", { class: "icon-button", title: "Expand all" }, "⊞");
    expand.addEventListener("click", () => {
      this.collapsed.clear();
      this.render();
    });
    const collapse = h("button", { class: "icon-button", title: "Collapse all" }, "⊟");
    collapse.addEventListener("click", () => {
      for (const l of this.data?.lists ?? []) this.collapsed.add(l.id);
      this.collapsed.add(UNVERSIONED);
      this.render();
    });
    this.tree = h("div", { class: "commit-tree", tabIndex: 0 });
    this.tree.addEventListener("keydown", (e) => this.onKey(e));
    this.message = h("textarea", { class: "commit-message", placeholder: "Commit message", spellcheck: true, rows: 5 });
    this.message.addEventListener("input", () => this.scheduleSave());
    this.message.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.commit(false);
      } else if (e.key.toLowerCase() === "k" && (e.ctrlKey || e.metaKey) && e.altKey) {
        e.preventDefault();
        this.commit(true);
      }
    });
    this.amend = h("input", { type: "checkbox" });
    this.amend.addEventListener("change", () => void this.toggleAmend());
    this.commitBtn = h("button", { class: "primary commit-button", title: "Commit the checked files (Ctrl+Enter)" }, "Commit");
    this.commitBtn.addEventListener("click", () => this.commit(false));
    this.pushBtn = h("button", { class: "commit-push", title: "Commit and Push (Ctrl+Alt+K)" }, "and Push…");
    this.pushBtn.addEventListener("click", () => this.commit(true));
    this.summary = h("span", { class: "commit-summary" });
    this.el = h(
      "section",
      { class: "commit-panel" },
      h("div", { class: "commit-toolbar" }, refresh, rollback, newList, h("span", { class: "spacer" }), expand, collapse),
      this.tree,
      h(
        "div",
        { class: "commit-bottom" },
        this.message,
        h(
          "div",
          { class: "commit-actions" },
          h("label", { class: "commit-amend", title: "Change the last commit" }, this.amend, "Amend"),
          this.summary,
          h("span", { class: "spacer" }),
          this.commitBtn,
          this.pushBtn,
        ),
      ),
    );
    this.render();
  }

  get changeCount(): number {
    return this.files.length;
  }

  get lists(): ChangeListView[] {
    return this.data?.lists ?? [];
  }

  get hasUnversioned(): boolean {
    return (this.data?.unversioned.length ?? 0) > 0;
  }

  get head(): string | null {
    return this.data?.head ?? null;
  }

  set(data: LocalChanges) {
    this.data = data;
    const files: LocalFile[] = [];
    for (const l of data.lists) for (const c of l.changes) files.push({ key: `f:${c.path}`, change: c, list: l.id });
    for (const p of data.unversioned) files.push({ key: `u:${p}`, change: { status: "?", path: p, old_path: null }, list: null });
    const keys = new Set(files.map((f) => f.key));
    const active = data.lists.find((l) => l.active)?.id;
    for (const k of [...this.included]) if (!keys.has(k)) this.included.delete(k);
    for (const k of [...this.partial.keys()]) if (!keys.has(k)) this.partial.delete(k);
    for (const k of [...this.selection]) if (!keys.has(k)) this.selection.delete(k);
    // New changes of the active changelist are checked, as in IntelliJ.
    for (const f of files) {
      if (this.seen.has(f.key)) continue;
      this.seen.add(f.key);
      if (f.list !== null && f.list === active) this.included.add(f.key);
    }
    this.files = files;
    this.render();
    this.updateTarget();
  }

  private emptyText = "Open a repository to see its local changes.";

  clear(message?: string) {
    this.emptyText = message ?? "Open a repository to see its local changes.";
    this.data = null;
    this.files = [];
    this.included.clear();
    this.seen.clear();
    this.selection.clear();
    this.target = null;
    this.message.value = "";
    this.amend.checked = false;
    this.render();
  }

  /** The excluded changes of a file, shared with the diff view. */
  excludedFor(key: string): Set<string> {
    return this.partial.get(key)?.excluded ?? new Set();
  }

  /** Sets the content to commit for a file with unchecked changes; null means the whole file. */
  setPartial(key: string, excluded: Set<string>, content: string | null) {
    if (content === null || !excluded.size) this.partial.delete(key);
    else {
      this.partial.set(key, { excluded, content });
      this.included.add(key);
    }
    this.render();
    this.updateTarget();
  }

  partialContent(key: string): string | null {
    return this.partial.get(key)?.content ?? null;
  }

  /** Checks only the files of one changelist. */
  includeOnly(listId: string) {
    this.included = new Set(this.files.filter((f) => f.list === listId).map((f) => f.key));
    for (const k of [...this.partial.keys()]) if (!this.included.has(k)) this.partial.delete(k);
    this.render();
    this.updateTarget();
  }

  focusMessage() {
    this.message.focus();
  }

  setActiveFile(key: string | null) {
    this.activeKey = key;
    for (const el of this.tree.querySelectorAll<HTMLElement>(".cl-file")) el.classList.toggle("active", el.dataset.key === key);
    this.tree.querySelector(".cl-file.active")?.scrollIntoView({ block: "nearest" });
  }

  /** Moves to the next or previous file in display order and opens it. */
  move(delta: number) {
    const order = this.visibleKeys();
    if (!order.length) return;
    const pos = this.activeKey ? order.indexOf(this.activeKey) : -1;
    const next = order[Math.max(0, Math.min(order.length - 1, pos < 0 ? 0 : pos + delta))];
    this.selection = new Set([next]);
    this.anchor = next;
    this.open(next);
  }

  /** The file whose diff is shown. */
  activeFile(): LocalFile | null {
    return this.files.find((f) => f.key === this.activeKey) ?? null;
  }

  selectedFiles(): LocalFile[] {
    return this.files.filter((f) => this.selection.has(f.key));
  }

  private visibleKeys(): string[] {
    return [...this.tree.querySelectorAll<HTMLElement>(".cl-file")].map((e) => e.dataset.key!);
  }

  private open(key: string) {
    const f = this.files.find((x) => x.key === key);
    if (!f) return;
    this.render();
    this.setActiveFile(key);
    this.onOpen(f);
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      this.move(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === " ") {
      e.preventDefault();
      const sel = this.selectedFiles();
      if (!sel.length) return;
      const on = !sel.every((f) => this.included.has(f.key));
      for (const f of sel) on ? this.included.add(f.key) : this.included.delete(f.key);
      this.render();
      this.updateTarget();
    } else if (e.key === "Delete" || (e.key === "z" && (e.ctrlKey || e.metaKey) && e.altKey)) {
      const sel = this.selectedFiles().filter((f) => f.list !== null);
      if (sel.length) {
        e.preventDefault();
        this.onRollback(sel);
      }
    }
  }

  /** The changelist that holds most checked files, else the active changelist. */
  private computeTarget(): string | null {
    const lists = this.data?.lists ?? [];
    let best: string | null = null;
    let most = 0;
    for (const l of lists) {
      const n = l.changes.filter((c) => this.included.has(`f:${c.path}`)).length;
      if (n > most) {
        most = n;
        best = l.id;
      }
    }
    return best ?? lists.find((l) => l.active)?.id ?? null;
  }

  private updateTarget() {
    const t = this.computeTarget();
    if (!this.amend.checked && t !== this.target) {
      this.flushSave();
      this.target = t;
      this.message.value = this.data?.lists.find((l) => l.id === t)?.comment ?? "";
    }
    this.target = t;
    this.updateSummary();
  }

  private updateSummary() {
    const n = this.files.filter((f) => this.included.has(f.key)).length;
    const p = [...this.partial.keys()].filter((k) => this.included.has(k)).length;
    this.summary.textContent = n ? `${n} file${n === 1 ? "" : "s"}${p ? `, ${p} in part` : ""}` : "";
    const verb = this.amend.checked ? "Amend Commit" : "Commit";
    const name = this.data?.lists.find((l) => l.id === this.target)?.name;
    const multi = (this.data?.lists.length ?? 0) > 1;
    this.commitBtn.textContent = multi && name && n ? `${verb} ${ellipsis(name, 18)}` : verb;
    this.commitBtn.disabled = !this.data || (n === 0 && !this.amend.checked);
    this.pushBtn.disabled = this.commitBtn.disabled;
  }

  private scheduleSave() {
    if (this.amend.checked) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.flushSave(), 500);
  }

  private flushSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    const l = this.data?.lists.find((x) => x.id === this.target);
    if (!l || this.amend.checked || l.comment === this.message.value) return;
    l.comment = this.message.value;
    this.onSaveMessage(l.id, this.message.value);
  }

  private async toggleAmend() {
    if (this.amend.checked) {
      this.flushSave();
      this.draftBeforeAmend = this.message.value;
      const last = await this.onAmendToggle(true);
      if (this.amend.checked && !this.draftBeforeAmend.trim()) this.message.value = last;
    } else {
      this.message.value = this.draftBeforeAmend;
    }
    this.updateSummary();
  }

  private commit(push: boolean) {
    if (this.commitBtn.disabled) return;
    const files = this.files.filter((f) => this.included.has(f.key));
    this.onCommit(files, this.message.value, this.amend.checked, this.target, push);
  }

  /** Called by the owner after a successful commit. */
  committed(list: string | null) {
    this.partial.clear();
    const wasAmend = this.amend.checked;
    this.amend.checked = false;
    this.message.value = wasAmend ? this.draftBeforeAmend : "";
    const l = this.data?.lists.find((x) => x.id === list);
    if (l && !wasAmend) l.comment = "";
    this.updateSummary();
  }

  private render() {
    const frag = document.createDocumentFragment();
    if (!this.data) {
      this.tree.replaceChildren(h("div", { class: "muted commit-empty" }, this.emptyText));
      this.updateSummary();
      return;
    }
    for (const l of this.data.lists) {
      frag.append(this.header(l.id, l.name, l.changes.map((c) => `f:${c.path}`), l));
      if (!this.collapsed.has(l.id)) for (const c of l.changes) frag.append(this.fileRow({ key: `f:${c.path}`, change: c, list: l.id }));
    }
    if (this.data.unversioned.length) {
      frag.append(this.header(UNVERSIONED, UNVERSIONED, this.data.unversioned.map((p) => `u:${p}`), null));
      if (!this.collapsed.has(UNVERSIONED)) {
        for (const p of this.data.unversioned) frag.append(this.fileRow({ key: `u:${p}`, change: { status: "?", path: p, old_path: null }, list: null }));
      }
    }
    if (!this.files.length) frag.append(h("div", { class: "muted commit-empty" }, "There are no local changes."));
    this.tree.replaceChildren(frag);
    this.setActiveFile(this.activeKey);
    this.updateSummary();
  }

  private header(id: string, name: string, keys: string[], list: ChangeListView | null): HTMLElement {
    const open = !this.collapsed.has(id);
    const n = keys.filter((k) => this.included.has(k)).length;
    const box = h("input", { type: "checkbox", class: "cl-check", disabled: keys.length === 0 });
    box.checked = keys.length > 0 && n === keys.length;
    box.indeterminate = n > 0 && n < keys.length;
    box.addEventListener("click", (e) => e.stopPropagation());
    box.addEventListener("change", () => {
      for (const k of keys) {
        if (box.checked) this.included.add(k);
        else this.included.delete(k);
        this.partial.delete(k);
      }
      this.render();
      this.updateTarget();
    });
    const twisty = h("span", { class: "twisty" }, open ? "▾" : "▸");
    const row = h(
      "div",
      { class: "cl-header" + (list?.active ? " active-list" : "") + (list ? "" : " unversioned"), "data-list": id, title: list?.comment || name },
      twisty,
      box,
      h("span", { class: "cl-name" }, name),
      h("span", { class: "cl-count" }, `${keys.length} file${keys.length === 1 ? "" : "s"}`),
      list?.comment ? h("span", { class: "cl-comment" }, list.comment.split("\n")[0]) : "",
    );
    row.addEventListener("click", () => {
      if (open) this.collapsed.add(id);
      else this.collapsed.delete(id);
      this.render();
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (list) this.onListMenu(list, e);
      else this.onUnversionedMenu(e);
    });
    if (list) {
      row.addEventListener("dragover", (e) => {
        if (!e.dataTransfer?.types.includes("text/x-rebased-paths")) return;
        e.preventDefault();
        row.classList.add("drop");
      });
      row.addEventListener("dragleave", () => row.classList.remove("drop"));
      row.addEventListener("drop", (e) => {
        e.preventDefault();
        row.classList.remove("drop");
        const paths = JSON.parse(e.dataTransfer?.getData("text/x-rebased-paths") || "[]") as string[];
        if (paths.length) this.onMove(paths, list.id);
      });
    }
    return row;
  }

  private fileRow(f: LocalFile): HTMLElement {
    const c = f.change;
    const slash = c.path.lastIndexOf("/");
    const box = h("input", { type: "checkbox", class: "cl-check", title: this.partial.has(f.key) ? "Some changes of this file stay out of the commit" : "" });
    box.checked = this.included.has(f.key);
    box.indeterminate = this.included.has(f.key) && this.partial.has(f.key);
    box.addEventListener("click", (e) => e.stopPropagation());
    box.addEventListener("change", () => {
      const targets = this.selection.has(f.key) ? this.selectedFiles().map((x) => x.key) : [f.key];
      for (const k of targets) {
        if (box.checked) this.included.add(k);
        else this.included.delete(k);
        this.partial.delete(k);
      }
      this.render();
      this.updateTarget();
    });
    const status = c.status === "?" ? "?" : c.status;
    const row = h(
      "div",
      {
        class: "cl-file change" + (this.selection.has(f.key) ? " selected" : ""),
        "data-key": f.key,
        draggable: f.list !== null,
        title: (c.old_path ? `${c.old_path} → ${c.path}` : c.path) + (c.status === "U" ? "\nConflict" : ""),
      },
      box,
      h("span", { class: `status status-${status}`, title: status === "?" ? "Unversioned" : c.status === "U" ? "Conflict" : statusName(c.status) }, status),
      h("span", { class: `path status-text-${status}` }, c.path.slice(slash + 1)),
      c.old_path ? h("span", { class: "dir" }, `← ${c.old_path}`) : slash > 0 ? h("span", { class: "dir" }, c.path.slice(0, slash)) : "",
    );
    row.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).tagName === "INPUT") return;
      if (e.ctrlKey || e.metaKey) {
        if (this.selection.has(f.key)) this.selection.delete(f.key);
        else this.selection.add(f.key);
        this.anchor = f.key;
        this.render();
        return;
      }
      if (e.shiftKey && this.anchor) {
        const order = this.visibleKeys();
        const [a, b] = [order.indexOf(this.anchor), order.indexOf(f.key)].sort((x, y) => x - y);
        this.selection = new Set(order.slice(a, b + 1));
        this.render();
        return;
      }
      this.selection = new Set([f.key]);
      this.anchor = f.key;
      this.open(f.key);
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (!this.selection.has(f.key)) {
        this.selection = new Set([f.key]);
        this.anchor = f.key;
        this.render();
      }
      this.onFileMenu(this.selectedFiles(), e);
    });
    row.addEventListener("dragstart", (e) => {
      if (!this.selection.has(f.key)) {
        this.selection = new Set([f.key]);
        this.render();
      }
      const paths = this.selectedFiles().filter((x) => x.list !== null).map((x) => x.change.path);
      e.dataTransfer?.setData("text/x-rebased-paths", JSON.stringify(paths));
      e.dataTransfer?.setData("text/plain", paths.join("\n"));
    });
    return row;
  }
}

function ellipsis(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
