// Monaco diff of one file, with a toolbar for navigation and diff options.

import * as monaco from "monaco-editor/esm/vs/editor/edcore.main";
import "monaco-editor/esm/vs/basic-languages/monaco.contribution";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import type { Blame, Change, FileContent, RevSpec } from "./api";
import { statusName } from "./changes-panel";
import { copyText, h } from "./dom";
import { save, settings } from "./settings";

(self as unknown as { MonacoEnvironment: object }).MonacoEnvironment = { getWorker: () => new EditorWorker() };

export function setMonacoTheme(dark: boolean) {
  monaco.editor.setTheme(dark ? "vs-dark" : "vs");
}

export class DiffView {
  readonly el: HTMLElement;
  private title: HTMLElement;
  private sides: HTMLElement;
  private stats: HTMLElement;
  private notice: HTMLElement;
  private host: HTMLElement;
  private editor: monaco.editor.IStandaloneDiffEditor;
  /** Shows an added or deleted file: one side has no content. */
  private single: monaco.editor.IStandaloneCodeEditor;
  private singleHost: HTMLElement;
  private path = "";
  /** The file and revision that Annotate shows: the right side, or the left side of a deleted file. */
  private source: { path: string; rev: RevSpec } | null = null;
  private annotateBox: HTMLInputElement;
  private historyBtn: HTMLButtonElement;
  private blameDeco: string[] = [];
  private blameEditor: monaco.editor.IStandaloneCodeEditor | null = null;
  private blameRequest = 0;
  onPrevFile: () => void = () => {};
  onNextFile: () => void = () => {};
  onBlame: (path: string, rev: RevSpec) => Promise<Blame> = () => Promise.reject(new Error("no blame"));
  onBlameClick: (oid: string) => void = () => {};
  onHistory: (path: string) => void = () => {};

  constructor() {
    const btn = (label: string, title: string, fn: () => void) => {
      const b = h("button", { class: "icon-button", title }, label);
      b.addEventListener("click", fn);
      return b;
    };
    const toggle = (label: string, key: "sideBySide" | "ignoreWhitespace" | "collapseUnchanged", title: string) => {
      const input = h("input", { type: "checkbox", checked: settings[key] });
      input.addEventListener("change", () => {
        settings[key] = input.checked;
        save();
        this.applyOptions();
      });
      return h("label", { class: "diff-option", title }, input, label);
    };
    this.title = h("span", { class: "diff-title" });
    this.sides = h("span", { class: "diff-sides" });
    this.stats = h("span", { class: "diff-stats" });
    const copyPath = btn("⧉", "Copy the file path", () => this.path && void copyText(this.path));
    this.annotateBox = h("input", { type: "checkbox" });
    this.annotateBox.addEventListener("change", () => void this.annotate());
    const annotate = h("label", { class: "diff-option", title: "Show the commit that last changed each line (git blame). Click an annotation to go to its commit." }, this.annotateBox, "Annotate");
    this.historyBtn = btn("🕘", "Show the history of this file", () => this.source && this.onHistory(this.source.path));
    const toolbar = h(
      "div",
      { class: "diff-toolbar" },
      btn("↑", "Previous change (Shift+F7)", () => this.goToDiff("previous")),
      btn("↓", "Next change (F7)", () => this.goToDiff("next")),
      btn("⇤", "Previous file (Alt+Up)", () => this.onPrevFile()),
      btn("⇥", "Next file (Alt+Down)", () => this.onNextFile()),
      this.title,
      copyPath,
      this.historyBtn,
      this.stats,
      h("span", { class: "spacer" }),
      this.sides,
      annotate,
      toggle("Side by side", "sideBySide", "Show the two versions side by side, or in one column"),
      toggle("Ignore whitespace", "ignoreWhitespace", "Ignore leading and trailing whitespace changes"),
      toggle("Collapse unchanged", "collapseUnchanged", "Hide unchanged regions"),
    );
    this.notice = h("div", { class: "diff-notice" });
    this.host = h("div", { class: "diff-host" });
    this.singleHost = h("div", { class: "diff-host", hidden: true });
    this.el = h("section", { class: "diff" }, toolbar, h("div", { class: "diff-area" }, this.notice, this.host, this.singleHost));
    this.editor = monaco.editor.createDiffEditor(this.host, {
      readOnly: true,
      originalEditable: false,
      automaticLayout: true,
      useInlineViewWhenSpaceIsLimited: false,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderOverviewRuler: true,
      fontSize: 12,
    });
    this.single = monaco.editor.create(this.singleHost, {
      readOnly: true,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 12,
    });
    this.applyOptions();
    this.editor.onDidUpdateDiff(() => this.updateStats());
    for (const e of [this.editor.getModifiedEditor(), this.single]) {
      e.onMouseDown((ev) => {
        if (!this.annotateBox.checked || this.blameEditor !== e || ev.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS) return;
        const oid = this.blameOids[(ev.target.position?.lineNumber ?? 0) - 1];
        if (oid) this.onBlameClick(oid);
      });
    }
    this.message("Select a file to see the diff.");
  }

  private applyOptions() {
    this.editor.updateOptions({
      renderSideBySide: settings.sideBySide,
      ignoreTrimWhitespace: settings.ignoreWhitespace,
      hideUnchangedRegions: { enabled: settings.collapseUnchanged },
    });
  }

  goToDiff(target: "next" | "previous") {
    this.editor.goToDiff(target);
  }

  focus() {
    this.editor.getModifiedEditor().focus();
  }

  private updateStats() {
    if (!this.notice.hidden) return;
    const changes = this.editor.getLineChanges() ?? [];
    let add = 0;
    let del = 0;
    for (const c of changes) {
      if (c.modifiedEndLineNumber > 0) add += c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1;
      if (c.originalEndLineNumber > 0) del += c.originalEndLineNumber - c.originalStartLineNumber + 1;
    }
    this.stats.replaceChildren(
      h("span", { class: "stat-add" }, `+${add}`),
      " ",
      h("span", { class: "stat-del" }, `−${del}`),
      h("span", { class: "muted-inline" }, ` · ${changes.length} change${changes.length === 1 ? "" : "s"}`),
    );
    if (changes.length) this.editor.revealLineInCenter(changes[0].modifiedStartLineNumber || 1);
  }

  private blameOids: (string | null)[] = [];

  /** Sets what Annotate and History use for the file on show. */
  setSource(source: { path: string; rev: RevSpec } | null) {
    this.source = source;
    this.historyBtn.disabled = !source;
  }

  private clearBlame() {
    this.blameRequest++;
    if (this.blameEditor) {
      this.blameEditor.updateOptions({ lineNumbers: "on", lineNumbersMinChars: 5 });
      this.blameDeco = this.blameEditor.deltaDecorations(this.blameDeco, []);
    }
    this.blameEditor = null;
    this.blameOids = [];
  }

  /** Shows the annotations of the source file in the gutter of the right editor. */
  private async annotate() {
    this.clearBlame();
    if (!this.annotateBox.checked || !this.source || !this.notice.hidden) return;
    const req = this.blameRequest;
    const editor = this.singleHost.hidden ? this.editor.getModifiedEditor() : this.single;
    let blame: Blame;
    try {
      blame = await this.onBlame(this.source.path, this.source.rev);
    } catch (e) {
      if (req === this.blameRequest) this.stats.append(h("span", { class: "muted-inline" }, ` · annotate: ${String(e).replace(/^Error: /, "")}`));
      return;
    }
    if (req !== this.blameRequest) return;
    const now = Date.now() / 1000;
    const times = blame.commits.filter((c) => !c.uncommitted).map((c) => c.time);
    const oldest = Math.min(now, ...times);
    const labels: string[] = [];
    const deco: monaco.editor.IModelDeltaDecoration[] = [];
    this.blameOids = [];
    blame.lines.forEach((ci, i) => {
      const c = blame.commits[ci];
      const first = i === 0 || blame.lines[i - 1] !== ci;
      this.blameOids.push(c.uncommitted ? null : c.oid);
      const date = new Date(c.time * 1000).toISOString().slice(0, 10);
      labels.push(!first ? "" : c.uncommitted ? "not committed" : `${date} ${c.author.length > 14 ? c.author.slice(0, 13) + "…" : c.author}`);
      // Newer lines get a stronger color, as in IntelliJ.
      const age = c.uncommitted ? 0 : Math.min(4, Math.floor(((now - c.time) / Math.max(1, now - oldest)) * 5));
      deco.push({
        range: new monaco.Range(i + 1, 1, i + 1, 1),
        options: {
          linesDecorationsClassName: `blame-age-${age}`,
          lineNumberClassName: first ? "blame-first" : "blame-rest",
          lineNumberHoverMessage: c.uncommitted ? { value: "Not committed yet" } : { value: `**${c.oid.slice(0, 8)}** ${c.author}, ${date}\n\n${c.summary}` },
        } as monaco.editor.IModelDecorationOptions,
      });
    });
    editor.updateOptions({ lineNumbers: (n: number) => labels[n - 1] ?? "", lineNumbersMinChars: 26 });
    this.blameDeco = editor.deltaDecorations([], deco);
    this.blameEditor = editor;
  }

  setSides(left: string, right: string) {
    this.sides.textContent = `${left}  ⟷  ${right}`;
  }

  message(text: string, title = "") {
    this.clearBlame();
    this.setSource(null);
    this.path = "";
    this.sides.textContent = "";
    this.title.textContent = title;
    this.stats.textContent = "";
    this.notice.textContent = text;
    this.notice.hidden = false;
    this.setModels("", "", undefined);
  }

  show(change: Change, left: FileContent, right: FileContent) {
    this.clearBlame();
    queueMicrotask(() => void this.annotate());
    this.path = change.path;
    this.title.replaceChildren(
      h("span", { class: `status status-${change.status}`, title: statusName(change.status) }, change.status),
      " ",
      change.old_path ? `${change.old_path} → ${change.path}` : change.path,
    );
    this.stats.textContent = "";
    const tooBig = (f: FileContent) => !f.binary && !f.missing && f.text === null && f.size > 0;
    if (left.binary || right.binary) return this.showNotice("Binary file. The contents cannot be compared as text.");
    if (tooBig(left) || tooBig(right)) return this.showNotice("The file is larger than 5 MB. The diff is not shown.");
    this.notice.hidden = true;
    const lang = languageFor(change.path);
    if (left.missing !== right.missing) {
      this.showSingle(right.missing ? left.text ?? "" : right.text ?? "", lang, right.missing ? "deleted" : "added");
      return;
    }
    this.setModels(left.text ?? "", right.text ?? "", lang);
  }

  /** An added or deleted file: its whole content in one editor, marked as added or removed. */
  private showSingle(text: string, lang: string | undefined, kind: "added" | "deleted") {
    this.host.hidden = true;
    this.singleHost.hidden = false;
    const old = this.single.getModel();
    const model = monaco.editor.createModel(text, lang);
    this.single.setModel(model);
    old?.dispose();
    const lines = text.endsWith("\n") ? model.getLineCount() - 1 : model.getLineCount();
    this.single.createDecorationsCollection([
      {
        range: new monaco.Range(1, 1, Math.max(1, lines), 1),
        options: { isWholeLine: true, className: kind === "added" ? "line-added" : "line-deleted" },
      },
    ]);
    this.stats.replaceChildren(
      kind === "added" ? h("span", { class: "stat-add" }, `+${lines}`) : h("span", { class: "stat-del" }, `−${lines}`),
      h("span", { class: "muted-inline" }, kind === "added" ? " · new file" : " · deleted file"),
    );
  }

  private showNotice(text: string) {
    this.notice.textContent = text;
    this.notice.hidden = false;
    this.setModels("", "", undefined);
  }

  private setModels(a: string, b: string, lang: string | undefined) {
    this.host.hidden = false;
    this.singleHost.hidden = true;
    const old = this.editor.getModel();
    this.editor.setModel({ original: monaco.editor.createModel(a, lang), modified: monaco.editor.createModel(b, lang) });
    old?.original.dispose();
    old?.modified.dispose();
  }
}

export function languageFor(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const ext = name.includes(".") ? "." + name.split(".").pop() : name;
  for (const l of monaco.languages.getLanguages()) {
    if (l.extensions?.includes(ext) || l.filenames?.map((f) => f.toLowerCase()).includes(name)) return l.id;
  }
  return undefined;
}
