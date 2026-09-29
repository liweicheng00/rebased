// Monaco diff of one file, with a toolbar for navigation and diff options.

import * as monaco from "./monaco";
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
  /** Created on first use: most files are shown in the diff editor. */
  private singleEditor: monaco.editor.IStandaloneCodeEditor | null = null;
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
  /** Local changes only: which changes go into the next commit. */
  private selectable: { excluded: Set<string>; onChange: (excluded: Set<string>, content: string | null) => void } | null = null;
  private hunkDeco: string[] = [];
  private hunks: { id: string; glyphLine: number; change: monaco.editor.ILineChange }[] = [];

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
    this.applyOptions();
    this.editor.onDidUpdateDiff(() => {
      this.updateStats();
      this.renderHunks();
    });
    this.editor.getModifiedEditor().onMouseDown((ev) => {
      if (!this.selectable || ev.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      const line = ev.target.position?.lineNumber;
      const hunk = this.hunks.find((x) => x.glyphLine === line);
      if (!hunk) return;
      const ex = this.selectable.excluded;
      if (ex.has(hunk.id)) ex.delete(hunk.id);
      else ex.add(hunk.id);
      this.renderHunks();
      this.selectable.onChange(ex, ex.size ? this.partialContent() : null);
    });
    this.listenForBlameClicks(this.editor.getModifiedEditor());
    this.message("Select a file to see the diff.");
  }

  private listenForBlameClicks(e: monaco.editor.IStandaloneCodeEditor | monaco.editor.ICodeEditor) {
    e.onMouseDown((ev) => {
      if (!this.annotateBox.checked || this.blameEditor !== e || ev.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS) return;
      const oid = this.blameOids[(ev.target.position?.lineNumber ?? 0) - 1];
      if (oid) this.onBlameClick(oid);
    });
  }

  private get single(): monaco.editor.IStandaloneCodeEditor {
    if (!this.singleEditor) {
      this.singleEditor = monaco.editor.create(this.singleHost, {
        readOnly: true,
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 12,
      });
      this.listenForBlameClicks(this.singleEditor);
    }
    return this.singleEditor;
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
    if (changes.length && this.revealFirst) this.editor.revealLineInCenter(changes[0].modifiedStartLineNumber || 1);
    this.revealFirst = true;
  }

  private blameOids: (string | null)[] = [];

  /**
   * Turns on the check boxes of the changes, for a local file. Unchecked changes stay out of the commit.
   * Call it before show().
   */
  setSelectable(sel: { excluded: Set<string>; onChange: (excluded: Set<string>, content: string | null) => void } | null) {
    this.selectable = sel;
    this.editor.getModifiedEditor().updateOptions({ glyphMargin: !!sel });
    this.renderHunks();
  }

  private renderHunks() {
    const ed = this.editor.getModifiedEditor();
    const changes = this.selectable && this.notice.hidden && this.singleHost.hidden ? this.editor.getLineChanges() ?? [] : [];
    this.hunks = changes.map((c) => ({
      id: `${c.originalStartLineNumber}:${c.originalEndLineNumber}:${c.modifiedStartLineNumber}:${c.modifiedEndLineNumber}`,
      glyphLine: Math.max(1, c.modifiedStartLineNumber),
      change: c,
    }));
    // Drop exclusions of changes that are gone.
    if (this.selectable && changes.length) {
      const ids = new Set(this.hunks.map((x) => x.id));
      let dropped = false;
      for (const id of [...this.selectable.excluded]) {
        if (!ids.has(id)) {
          this.selectable.excluded.delete(id);
          dropped = true;
        }
      }
      if (dropped) this.selectable.onChange(this.selectable.excluded, this.selectable.excluded.size ? this.partialContent() : null);
    }
    const deco: monaco.editor.IModelDeltaDecoration[] = [];
    for (const x of this.hunks) {
      const off = this.selectable!.excluded.has(x.id);
      deco.push({
        range: new monaco.Range(x.glyphLine, 1, x.glyphLine, 1),
        options: {
          glyphMarginClassName: off ? "hunk-off" : "hunk-on",
          glyphMarginHoverMessage: { value: off ? "This change stays out of the commit. Click to include it." : "This change goes into the commit. Click to leave it out." },
        },
      });
      if (off && x.change.modifiedEndLineNumber > 0) {
        deco.push({
          range: new monaco.Range(x.change.modifiedStartLineNumber, 1, x.change.modifiedEndLineNumber, 1),
          options: { isWholeLine: true, className: "hunk-excluded" },
        });
      }
    }
    this.hunkDeco = ed.deltaDecorations(this.hunkDeco, deco);
  }

  /** The file content with only the checked changes applied to the left side. */
  private partialContent(): string {
    const model = this.editor.getModel()!;
    const a = model.original.getLinesContent();
    const b = model.modified.getLinesContent();
    const out: string[] = [];
    let pos = 1;
    for (const x of this.hunks) {
      const c = x.change;
      const oStart = c.originalEndLineNumber === 0 ? c.originalStartLineNumber + 1 : c.originalStartLineNumber;
      const oEnd = c.originalEndLineNumber === 0 ? c.originalStartLineNumber : c.originalEndLineNumber;
      out.push(...a.slice(pos - 1, oStart - 1));
      if (this.selectable!.excluded.has(x.id)) out.push(...a.slice(oStart - 1, oEnd));
      else if (c.modifiedEndLineNumber > 0) out.push(...b.slice(c.modifiedStartLineNumber - 1, c.modifiedEndLineNumber));
      pos = oEnd + 1;
    }
    out.push(...a.slice(pos - 1));
    return out.join(model.modified.getEOL());
  }

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
    // The same file again (for example after it changed on disk): keep the scroll position.
    const same = change.path === this.path && this.notice.hidden && this.singleHost.hidden;
    this.keepView = same ? this.editor.getModifiedEditor().saveViewState() : null;
    this.revealFirst = !same;
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

  private keepView: monaco.editor.ICodeEditorViewState | null = null;
  /** Scroll to the first change when the diff is ready; not when the same file is shown again. */
  private revealFirst = true;

  private setModels(a: string, b: string, lang: string | undefined) {
    this.host.hidden = false;
    this.singleHost.hidden = true;
    const old = this.editor.getModel();
    this.editor.setModel({ original: monaco.editor.createModel(a, lang), modified: monaco.editor.createModel(b, lang) });
    old?.original.dispose();
    old?.modified.dispose();
    if (this.keepView) {
      this.editor.getModifiedEditor().restoreViewState(this.keepView);
      this.keepView = null;
    }
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
