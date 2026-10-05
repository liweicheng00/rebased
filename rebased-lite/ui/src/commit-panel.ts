// Commit panel: local changes grouped by changelist, as in IntelliJ's Commit tool window.
// The checked files go into the commit. By default the files of the active changelist are checked.

import type { Change, ChangeListView, LocalChanges } from "./api";
import { statusName } from "./changes-panel";
import { fileIcon } from "./file-icon";
import { buildTree, treeOrder, walkTree } from "./file-tree";
import { h } from "./dom";
import { save, settings } from "./settings";

/** A file row: a tracked change in a changelist, or an unversioned file. */
export interface LocalFile {
  key: string;
  change: Change;
  /** The changelist id, or null for an unversioned file. */
  list: string | null;
  /** The file has hunks in other changelists too. The row stands for the hunks of its changelist. */
  split?: boolean;
}

/** The key of a file row. A file in more than one changelist has one row in each. */
export function fileKey(list: string, path: string, split: boolean): string {
  return split ? `s:${list}:${path}` : `f:${path}`;
}

const UNVERSIONED = "Unversioned Files";

/** Problems of a commit message, from the settings. Comment lines (#) do not count. */
export function messageWarnings(message: string, template: string | null): string[] {
  const lines = message.split("\n").filter((l) => !l.startsWith("#"));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.join("").trim()) return [];
  const out: string[] = [];
  const subject = lines[0];
  if (settings.subjectLimit > 0 && subject.length > settings.subjectLimit) {
    out.push(`The subject has ${subject.length} characters. Keep it at ${settings.subjectLimit} or fewer.`);
  }
  if (settings.blankAfterSubject && lines.length > 1 && lines[1].trim()) out.push("Put a blank line after the subject.");
  if (settings.bodyLimit > 0) {
    const long = lines.slice(1).map((l, i) => [i + 2, l.length]).filter(([, n]) => n > settings.bodyLimit);
    if (long.length) out.push(`Line${long.length > 1 ? "s" : ""} ${long.map(([i]) => i).join(", ")} ${long.length > 1 ? "are" : "is"} longer than ${settings.bodyLimit} characters.`);
  }
  if (template) {
    const strip = (t: string) => t.split("\n").filter((l) => !l.startsWith("#")).join("\n").trim();
    if (strip(template) && strip(template) === strip(message)) out.push("The message is the commit template. Write your own message.");
  }
  return out;
}

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
  /** A double click on a file. */
  onActivate: (f: LocalFile) => void = () => {};
  onFileMenu: (files: LocalFile[], e: MouseEvent) => void = () => {};
  onListMenu: (list: ChangeListView, e: MouseEvent) => void = () => {};
  onUnversionedMenu: (e: MouseEvent) => void = () => {};
  onMove: (paths: string[], to: string) => void = () => {};
  onCommit: (files: LocalFile[], message: string, amend: boolean, list: string | null, push: boolean, signOff: boolean) => void = () => {};
  onSaveMessage: (list: string, message: string) => void = () => {};
  onAmendToggle: (on: boolean) => Promise<string> = async () => "";
  onRefresh: () => void = () => {};
  onRollback: (files: LocalFile[]) => void = () => {};
  onNewChangeList: () => void = () => {};
  /** Shows the recent commit messages below the anchor. */
  onMessageHistory: (anchor: HTMLElement) => void = () => {};
  private signOff: HTMLInputElement;
  private warnings: HTMLElement;
  /** The text of commit.template, for an empty message. */
  private template: string | null = null;
  private historyBtn: HTMLButtonElement;

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
    const treeBtn = h("button", { class: "icon-button changes-tree-toggle" });
    const paintTreeBtn = () => {
      treeBtn.textContent = settings.localChangesAsTree ? "☰" : "🗀";
      treeBtn.title = settings.localChangesAsTree ? "Show as a flat list" : "Group by folder";
    };
    paintTreeBtn();
    treeBtn.addEventListener("click", () => {
      settings.localChangesAsTree = !settings.localChangesAsTree;
      save();
      paintTreeBtn();
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
    this.message.addEventListener("input", () => {
      this.scheduleSave();
      this.checkMessage();
    });
    this.warnings = h("div", { class: "commit-warnings", hidden: true });
    this.message.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.commit(false);
      } else if (e.key.toLowerCase() === "k" && (e.ctrlKey || e.metaKey) && e.altKey) {
        e.preventDefault();
        this.commit(true);
      } else if (e.code === "KeyM" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        this.onMessageHistory(this.historyBtn);
      }
    });
    this.historyBtn = h("button", { class: "icon-button commit-history", title: "Recent commit messages (Ctrl+M in the message)" }, "🕘");
    this.historyBtn.addEventListener("click", () => this.onMessageHistory(this.historyBtn));
    this.signOff = h("input", { type: "checkbox", checked: settings.signOff });
    this.signOff.addEventListener("change", () => {
      settings.signOff = this.signOff.checked;
      save();
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
      h("div", { class: "commit-toolbar" }, refresh, rollback, newList, h("span", { class: "spacer" }), treeBtn, expand, collapse),
      this.tree,
      h(
        "div",
        { class: "commit-bottom" },
        this.message,
        this.warnings,
        h(
          "div",
          { class: "commit-actions" },
          h("label", { class: "commit-amend", title: "Change the last commit" }, this.amend, "Amend"),
          h("label", { class: "commit-amend", title: "Add \"Signed-off-by\" with your name, as git commit -s" }, this.signOff, "Sign-off"),
          this.historyBtn,
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
    for (const l of data.lists) for (const c of l.changes) files.push(this.tracked(l.id, c));
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

  private tracked(list: string, c: Change): LocalFile {
    const split = !!this.data?.hunks[c.path];
    return { key: fileKey(list, c.path, split), change: c, list, split };
  }

  /** The hunks of a file that is in more than one changelist. */
  hunksOf(path: string) {
    return this.data?.hunks[path] ?? null;
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

  /** Puts a message into the message field, for example from the history. */
  setMessage(text: string) {
    this.message.value = text;
    this.scheduleSave();
    this.checkMessage();
    this.message.focus();
  }

  /** Sets the commit template; an empty message field gets it. */
  setTemplate(t: string | null) {
    this.template = t && t.trim() ? t : null;
    if (!this.message.value && this.template && !this.amend.checked) this.message.value = this.template;
    this.checkMessage();
  }

  /** The warnings of the current message. */
  get messageWarnings(): string[] {
    return messageWarnings(this.message.value, this.template);
  }

  checkMessage() {
    const w = this.messageWarnings;
    this.warnings.hidden = !w.length;
    this.warnings.replaceChildren(...w.map((x) => h("div", {}, "⚠ ", x)));
  }

  get messageText(): string {
    return this.message.value;
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

  /** Selects and opens the row of a file, in the given changelist when the file is there. */
  revealFile(path: string, list: string | null) {
    const f = this.files.find((x) => x.change.path === path && x.list === list) ?? this.files.find((x) => x.change.path === path);
    if (!f) return;
    this.selection = new Set([f.key]);
    this.anchor = f.key;
    this.open(f.key);
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

  private open(key: string, redraw = true) {
    const f = this.files.find((x) => x.key === key);
    if (!f) return;
    if (redraw) this.render();
    else this.paintSelection();
    this.setActiveFile(key);
    this.onOpen(f);
  }

  /** Marks the selected rows without new rows. A mouse press keeps its row, so WebKit can start a drag from it. */
  private paintSelection() {
    for (const el of this.tree.querySelectorAll<HTMLElement>(".cl-file")) el.classList.toggle("selected", this.selection.has(el.dataset.key!));
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
      const n = l.changes.filter((c) => this.included.has(this.tracked(l.id, c).key)).length;
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
      this.message.value = this.data?.lists.find((l) => l.id === t)?.comment || this.template || "";
      this.checkMessage();
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
    // The template alone is no draft.
    const value = this.message.value === this.template ? "" : this.message.value;
    if (!l || this.amend.checked || l.comment === value) return;
    l.comment = value;
    this.onSaveMessage(l.id, value);
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
    this.onCommit(files, this.message.value, this.amend.checked, this.target, push, this.signOff.checked);
  }

  /** Called by the owner after a successful commit. */
  committed(list: string | null) {
    this.partial.clear();
    const wasAmend = this.amend.checked;
    this.amend.checked = false;
    this.message.value = wasAmend ? this.draftBeforeAmend : this.template ?? "";
    this.checkMessage();
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
      frag.append(this.header(l.id, l.name, l.changes.map((c) => this.tracked(l.id, c).key), l));
      if (!this.collapsed.has(l.id)) this.appendFiles(frag, l.id, l.changes.map((c) => this.tracked(l.id, c)));
    }
    if (this.data.unversioned.length) {
      frag.append(this.header(UNVERSIONED, UNVERSIONED, this.data.unversioned.map((p) => `u:${p}`), null));
      if (!this.collapsed.has(UNVERSIONED)) {
        this.appendFiles(frag, UNVERSIONED, this.data.unversioned.map((p) => ({ key: `u:${p}`, change: { status: "?", path: p, old_path: null }, list: null })));
      }
    }
    if (!this.files.length) frag.append(h("div", { class: "muted commit-empty" }, "There are no local changes."));
    this.tree.replaceChildren(frag);
    this.setActiveFile(this.activeKey);
    this.updateSummary();
  }

  /** The rows of the files of one changelist: a flat list, or a tree of folders. */
  private appendFiles(frag: DocumentFragment, listId: string, files: LocalFile[]) {
    if (!settings.localChangesAsTree) {
      for (const f of files) frag.append(this.fileRow(f));
      return;
    }
    const sorted = [...files].sort((a, b) => treeOrder(a.change.path, b.change.path));
    const tree = buildTree(sorted.map((f, index) => ({ path: f.change.path, index })));
    // The folders of each changelist open and close on their own.
    const prefix = `${listId}\0`;
    const closed = new Set([...this.collapsed].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)));
    walkTree(tree, closed, {
      dir: (label, full, depth, open, _count, _viewed, indexes) => frag.append(this.dirRow(prefix + full, label, depth, open, indexes.map((i) => sorted[i]))),
      file: (index, depth) => frag.append(this.fileRow(sorted[index], depth)),
    });
  }

  /** A folder in the tree. Its box checks all of its files, and the menu and a drag take all of them. */
  private dirRow(id: string, label: string, depth: number, open: boolean, files: LocalFile[]): HTMLElement {
    const keys = files.map((f) => f.key);
    const n = keys.filter((k) => this.included.has(k)).length;
    const box = h("input", { type: "checkbox", class: "cl-check" });
    box.checked = n === keys.length;
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
    const row = h(
      "div",
      { class: "cl-dir", style: { paddingLeft: `${10 + depth * 14}px` }, title: id.slice(id.indexOf("\0") + 1), draggable: files.some((f) => f.list !== null) },
      h("span", { class: "twisty" }, open ? "▾" : "▸"),
      box,
      h("span", { class: "dir-name" }, label),
      h("span", { class: "cl-count" }, String(files.length)),
    );
    row.addEventListener("click", () => {
      if (open) this.collapsed.add(id);
      else this.collapsed.delete(id);
      this.render();
    });
    const selectAll = () => {
      this.selection = new Set(keys);
      this.paintSelection();
    };
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      selectAll();
      this.onFileMenu(this.selectedFiles(), e);
    });
    row.addEventListener("dragstart", (e) => {
      selectAll();
      const paths = files.filter((x) => x.list !== null).map((x) => x.change.path);
      e.dataTransfer?.setData("text/x-rebased-paths", JSON.stringify(paths));
      e.dataTransfer?.setData("text/plain", paths.join("\n"));
    });
    return row;
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

  /** A file row. `depth` is its level in the tree, or undefined in the flat list. */
  private fileRow(f: LocalFile, depth?: number): HTMLElement {
    const c = f.change;
    const slash = c.path.lastIndexOf("/");
    const box = h("input", {
      type: "checkbox",
      class: "cl-check",
      title: this.partial.has(f.key) ? "Some changes of this file stay out of the commit" : f.split ? "The changes of this file in this changelist" : "",
    });
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
      fileIcon(c.path),
      h("span", { class: `path status-text-${status}` }, c.path.slice(slash + 1)),
      c.old_path ? h("span", { class: "dir" }, `← ${c.old_path}`) : slash > 0 && depth === undefined ? h("span", { class: "dir" }, c.path.slice(0, slash)) : "",
      f.split ? h("span", { class: "cl-split", title: this.splitTitle(f) }, `${this.hunksOf(c.path)!.filter((x) => x.list === f.list).length}/${this.hunksOf(c.path)!.length}`) : "",
      h("span", { class: `status status-end status-${status}`, title: status === "?" ? "Unversioned" : c.status === "U" ? "Conflict" : statusName(c.status) }, status),
    );
    // A press on a file of a multiple selection keeps the selection, so that a drag moves all of the
    // files. A click without a drag then selects that file only.
    let keepForDrag = false;
    if (depth !== undefined) row.style.paddingLeft = `${24 + depth * 14}px`;
    row.addEventListener("mousedown", (e) => {
      keepForDrag = false;
      if (e.button !== 0 || (e.target as HTMLElement).tagName === "INPUT") return;
      if (e.ctrlKey || e.metaKey) {
        if (this.selection.has(f.key)) this.selection.delete(f.key);
        else this.selection.add(f.key);
        this.anchor = f.key;
        this.paintSelection();
        return;
      }
      if (e.shiftKey && this.anchor) {
        const order = this.visibleKeys();
        const [a, b] = [order.indexOf(this.anchor), order.indexOf(f.key)].sort((x, y) => x - y);
        this.selection = new Set(order.slice(a, b + 1));
        this.paintSelection();
        return;
      }
      // The click count of the mousedown counts a double click, also when a render replaced the row.
      if (e.detail === 2) {
        this.onActivate(f);
        return;
      }
      if (this.selection.has(f.key) && this.selection.size > 1) {
        keepForDrag = true;
        return;
      }
      this.selection = new Set([f.key]);
      this.anchor = f.key;
      this.open(f.key, false);
    });
    row.addEventListener("click", (e) => {
      if (!keepForDrag || e.ctrlKey || e.metaKey || e.shiftKey) return;
      keepForDrag = false;
      this.selection = new Set([f.key]);
      this.anchor = f.key;
      this.open(f.key, false);
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
      keepForDrag = false;
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

  /** Where the changes of a split file are, for the tooltip of its row. */
  private splitTitle(f: LocalFile): string {
    const hunks = this.hunksOf(f.change.path) ?? [];
    const names = new Map((this.data?.lists ?? []).map((l) => [l.id, l.name]));
    const count = new Map<string, number>();
    for (const x of hunks) count.set(x.list, (count.get(x.list) ?? 0) + 1);
    return [...count].map(([id, n]) => `${n} change${n === 1 ? "" : "s"} in ${names.get(id) ?? id}`).join("\n");
  }
}

function ellipsis(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
