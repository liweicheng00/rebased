// Changed files between two revisions, and a Monaco diff of the selected file.

import * as monaco from "monaco-editor/esm/vs/editor/edcore.main";
import "monaco-editor/esm/vs/basic-languages/monaco.contribution";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { api, type Change, type RevSpec, type Row } from "./api";

(self as unknown as { MonacoEnvironment: object }).MonacoEnvironment = { getWorker: () => new EditorWorker() };

const dark = matchMedia("(prefers-color-scheme: dark)");
monaco.editor.setTheme(dark.matches ? "vs-dark" : "vs");
dark.addEventListener("change", () => monaco.editor.setTheme(dark.matches ? "vs-dark" : "vs"));

export class CompareView {
  readonly el: HTMLElement;
  private header: HTMLElement;
  private list: HTMLElement;
  private diffHost: HTMLElement;
  private notice: HTMLElement;
  private editor: monaco.editor.IStandaloneDiffEditor;
  private left: RevSpec = "worktree";
  private right: RevSpec = "worktree";
  private changes: Change[] = [];
  private active = -1;
  private request = 0;
  private sideBySide = true;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "compare";
    this.header = document.createElement("div");
    this.header.className = "compare-header";
    const main = document.createElement("div");
    main.className = "compare-main";
    this.list = document.createElement("div");
    this.list.className = "changes";
    const right = document.createElement("div");
    right.className = "diff";
    this.notice = document.createElement("div");
    this.notice.className = "diff-notice";
    this.diffHost = document.createElement("div");
    this.diffHost.className = "diff-host";
    right.append(this.notice, this.diffHost);
    main.append(this.list, right);
    this.el.append(this.header, main);
    this.editor = monaco.editor.createDiffEditor(this.diffHost, {
      readOnly: true,
      originalEditable: false,
      automaticLayout: true,
      renderSideBySide: true,
      useInlineViewWhenSpaceIsLimited: false,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderOverviewRuler: true,
      fontSize: 12,
    });
    this.showMessage("Select a commit, or two commits to compare.");
  }

  toggleSideBySide(): boolean {
    this.sideBySide = !this.sideBySide;
    this.editor.updateOptions({ renderSideBySide: this.sideBySide });
    return this.sideBySide;
  }

  /** One row: the commit against its first parent. Two rows: the lower (older) row against the upper row. */
  async showSelection(rows: Row[]) {
    if (rows.length === 0) return;
    if (rows.length === 1) {
      await this.compare({ parentOf: rows[0].oid }, { commit: rows[0].oid }, `${short(rows[0])} and its parent`);
    } else {
      const [a, b] = rows.slice(-2).sort((x, y) => x.row - y.row);
      await this.compare({ commit: b.oid }, { commit: a.oid }, `${short(b)} → ${short(a)}`);
    }
  }

  async compareWithWorktree(row: Row) {
    await this.compare({ commit: row.oid }, "worktree", `${short(row)} → working tree`);
  }

  swap() {
    if (this.right === "worktree") return;
    const title = this.header.querySelector(".title")?.textContent ?? "";
    void this.compare(this.right, this.left, title.includes(" → ") ? title.split(" → ").reverse().join(" → ") : title);
  }

  private async compare(left: RevSpec, right: RevSpec, title: string) {
    const req = ++this.request;
    this.left = left;
    this.right = right;
    this.header.innerHTML = "";
    const t = document.createElement("span");
    t.className = "title";
    t.textContent = title;
    this.header.append(t);
    this.list.replaceChildren(loading());
    this.active = -1;
    this.changes = [];
    this.showMessage("Loading…");
    try {
      const { changes } = await api.compare(left, right);
      if (req !== this.request) return;
      this.changes = changes;
      const count = document.createElement("span");
      count.className = "count";
      count.textContent = `${changes.length} file${changes.length === 1 ? "" : "s"} changed`;
      this.header.append(count);
      this.renderList();
      if (changes.length) void this.openFile(0);
      else this.showMessage("No changes.");
    } catch (e) {
      if (req === this.request) this.list.replaceChildren(error(e));
    }
  }

  private renderList() {
    const frag = document.createDocumentFragment();
    this.changes.forEach((c, i) => {
      const item = document.createElement("div");
      item.className = "change" + (i === this.active ? " active" : "");
      const st = document.createElement("span");
      st.className = `status status-${c.status}`;
      st.textContent = c.status;
      const name = document.createElement("span");
      name.className = "path";
      const slash = c.path.lastIndexOf("/");
      name.textContent = c.path.slice(slash + 1);
      const dir = document.createElement("span");
      dir.className = "dir";
      dir.textContent = slash > 0 ? c.path.slice(0, slash) : "";
      item.title = c.old_path ? `${c.old_path} → ${c.path}` : c.path;
      item.append(st, name, dir);
      item.addEventListener("click", () => void this.openFile(i));
      frag.append(item);
    });
    this.list.replaceChildren(frag);
  }

  private async openFile(i: number) {
    const req = this.request;
    this.active = i;
    this.renderList();
    const c = this.changes[i];
    const pair = await api.filePair(this.left, this.right, c.path, c.old_path);
    if (req !== this.request || this.active !== i) return;
    const tooBig = (f: { size: number; text: string | null; binary: boolean }) => !f.binary && f.text === null && f.size > 0;
    if (pair.left.binary || pair.right.binary) return this.showMessage("Binary file changed.");
    if (tooBig(pair.left) || tooBig(pair.right)) return this.showMessage("The file is too large to show a diff.");
    this.notice.hidden = true;
    const lang = languageFor(c.path);
    const old = this.editor.getModel();
    this.editor.setModel({
      original: monaco.editor.createModel(pair.left.text ?? "", lang),
      modified: monaco.editor.createModel(pair.right.text ?? "", lang),
    });
    old?.original.dispose();
    old?.modified.dispose();
  }

  private showMessage(text: string) {
    this.notice.textContent = text;
    this.notice.hidden = false;
    const old = this.editor.getModel();
    this.editor.setModel({ original: monaco.editor.createModel(""), modified: monaco.editor.createModel("") });
    old?.original.dispose();
    old?.modified.dispose();
  }
}

function short(r: Row): string {
  return r.oid.slice(0, 8);
}

function loading(): HTMLElement {
  const d = document.createElement("div");
  d.className = "muted";
  d.textContent = "Loading…";
  return d;
}

function error(e: unknown): HTMLElement {
  const d = document.createElement("div");
  d.className = "error";
  d.textContent = String(e);
  return d;
}

function languageFor(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const ext = name.includes(".") ? "." + name.split(".").pop() : name;
  for (const l of monaco.languages.getLanguages()) {
    if (l.extensions?.includes(ext) || l.filenames?.map((f) => f.toLowerCase()).includes(name)) return l.id;
  }
  return undefined;
}
