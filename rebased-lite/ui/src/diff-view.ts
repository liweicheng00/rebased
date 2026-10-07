// Monaco diff of one file, with a toolbar for navigation and diff options.

import { revertChange } from "./revert-change";
import * as monaco from "./monaco";
import "monaco-editor/esm/vs/basic-languages/monaco.contribution";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import type { Blame, Change, FileContent, RevSpec } from "./api";
import { statusName } from "./changes-panel";
import { copyText, h, icon } from "./dom";
import { save, settings } from "./settings";

(self as unknown as { MonacoEnvironment: object }).MonacoEnvironment = { getWorker: () => new EditorWorker() };

export function setMonacoTheme(dark: boolean) {
  monaco.editor.setTheme(dark ? "vs-dark" : "vs");
}

/** The editor font of the diff and merge views, from the settings. */
export function editorFont(): { fontSize: number; fontFamily?: string } {
  return { fontSize: settings.diffFontSize, ...(settings.diffFontFamily.trim() ? { fontFamily: settings.diffFontFamily.trim() } : {}) };
}

const views = new Set<DiffView>();

/** Applies the diff settings (font, layout options) to every diff view. */
export function applyDiffSettings() {
  for (const v of views) v.applySettings();
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
  onHide: () => void = () => {};
  /** Open in Editor: the file of the right side, at a line and a column. */
  onOpenInEditor: (path: string, line: number, column: number) => void = () => {};
  /** The place of the cursor after the user moved it in the file. Null until then. */
  private userPos: { line: number; column: number } | null = null;
  /** Local changes only: which changes go into the next commit. */
  private selectable: { excluded: Set<string>; onChange: (excluded: Set<string>, content: string | null) => void } | null = null;
  private hunkDeco: string[] = [];
  /** A file in more than one changelist: the changes of the other changelists, marked in the diff. */
  private listHunks: { start: number; lines: number; label: string }[] = [];
  private listDeco: string[] = [];
  /** Review notes: marked lines of the right side. */
  private notes: { line: number; text: string }[] = [];
  private noteDeco: string[] = [];
  private singleNoteDeco: string[] = [];
  private menuAt = { x: 0, y: 0 };
  private moveKey: monaco.editor.IContextKey<boolean>;
  /** Local changes only: move the change at a working-tree line to another changelist. */
  onMoveChange: ((line: number, at: { x: number; y: number }) => void) | null = null;
  private hunks: { id: string; glyphLine: number; change: monaco.editor.ILineChange }[] = [];
  /** The texts of the two sides as they came, for Revert This Change. */
  private texts = { left: "", right: "" };
  /** The right side is the working tree: Revert This Change writes the file. Null turns it off. */
  private onRevert: ((path: string, text: string, expected: string) => void) | null = null;
  private revertKey: monaco.editor.IContextKey<boolean>;
  private revertDeco: string[] = [];
  private revertGlyphs: { line: number; change: monaco.editor.ILineChange }[] = [];

  constructor() {
    const btn = (label: string | Node, title: string, fn: () => void) => {
      const b = h("button", { class: "icon-button", title }, label);
      b.addEventListener("click", fn);
      return b;
    };
    const toggle = (label: string, key: "sideBySide" | "ignoreWhitespace" | "collapseUnchanged", title: string) => {
      const input = h("input", { type: "checkbox", checked: settings[key], "data-key": key });
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
    const copyPath = btn(icon("copy"), "Copy the file path", () => this.path && void copyText(this.path));
    this.annotateBox = h("input", { type: "checkbox" });
    this.annotateBox.addEventListener("change", () => void this.annotate());
    const annotate = h("label", { class: "diff-option", title: "Show the commit that last changed each line (git blame). Click an annotation to go to its commit." }, this.annotateBox, "Annotate");
    this.historyBtn = btn(icon("history"), "Show the history of this file", () => this.source && this.onHistory(this.source.path));
    const editBtn = btn(icon("edit"), "Open in the editor (F4)", () => this.openInEditor());
    editBtn.classList.add("diff-open-editor");
    const toolbar = h(
      "div",
      { class: "diff-toolbar" },
      btn(icon("up"), "Previous change (Shift+F7)", () => this.goToDiff("previous")),
      btn(icon("down"), "Next change (F7)", () => this.goToDiff("next")),
      btn(icon("prev-file"), "Previous file (Alt+Up)", () => this.onPrevFile()),
      btn(icon("next-file"), "Next file (Alt+Down)", () => this.onNextFile()),
      this.title,
      copyPath,
      this.historyBtn,
      editBtn,
      this.stats,
      h("span", { class: "spacer" }),
      this.sides,
      annotate,
      toggle("Side by side", "sideBySide", "Show the two versions side by side, or in one column"),
      toggle("Ignore whitespace", "ignoreWhitespace", "Ignore leading and trailing whitespace changes"),
      toggle("Collapse unchanged", "collapseUnchanged", "Hide unchanged regions"),
      btn(icon("close"), "Hide the diff panel", () => this.onHide()),
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
      ...editorFont(),
    });
    views.add(this);
    this.applyOptions();
    this.editor.onDidUpdateDiff(() => {
      this.updateStats();
      this.renderHunks();
      this.renderListHunks();
      this.renderNotes();
      this.renderRevert();
    });
    this.trackCursor(this.editor.getModifiedEditor());
    this.editor.getModifiedEditor().onMouseDown((ev) => {
      if (ev.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      // The left lane has the revert buttons, the right lane the check boxes of a commit.
      const glyph = this.revertGlyphs.find((g) => g.line === ev.target.position?.lineNumber);
      const lane = (ev.target.detail as monaco.editor.IMouseTargetMarginData | undefined)?.glyphMarginLane;
      if (glyph && (!this.selectable || lane === monaco.editor.GlyphMarginLane.Left)) return this.revertChange(glyph.change);
      if (!this.selectable) return;
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
    const modified = this.editor.getModifiedEditor();
    this.moveKey = modified.createContextKey("rebasedCanMoveChange", false);
    modified.onContextMenu((e) => (this.menuAt = { x: e.event.posx, y: e.event.posy }));
    modified.addAction({
      id: "rebased.moveChange",
      label: "Move Change to Another Changelist…",
      precondition: "rebasedCanMoveChange",
      contextMenuGroupId: "0_changelist",
      run: (ed) => {
        const line = ed.getPosition()?.lineNumber;
        const fn = this.onMoveChange;
        // Open the menu after the click that chose this action, so that click does not close it.
        if (line && fn) setTimeout(() => fn(line, this.menuAt), 50);
      },
    });
    this.revertKey = modified.createContextKey("rebasedCanRevert", false);
    modified.addAction({
      id: "rebased.revertChange",
      label: "Revert This Change",
      precondition: "rebasedCanRevert",
      contextMenuGroupId: "0_changelist",
      contextMenuOrder: 0,
      run: (ed) => {
        const line = ed.getPosition()?.lineNumber ?? 0;
        const c = (this.editor.getLineChanges() ?? []).find((x) =>
          x.modifiedEndLineNumber === 0 ? line === x.modifiedStartLineNumber || line === x.modifiedStartLineNumber + 1 : line >= x.modifiedStartLineNumber && line <= x.modifiedEndLineNumber,
        );
        if (c) this.revertChange(c);
      },
    });
    this.message("Select a file to see the diff.");
  }

  /**
   * The right side is the working tree: each change gets a revert button, and the menu gets Revert This
   * Change. `fn` writes the new text of the file when the text on disk is still `expected`. Null turns
   * it off. Call it before show().
   */
  setRevert(fn: ((path: string, text: string, expected: string) => void) | null) {
    this.onRevert = fn;
    this.renderRevert();
  }

  private revertChange(c: monaco.editor.ILineChange) {
    if (!this.onRevert || !this.path) return;
    this.onRevert(this.path, revertChange(this.texts.left, this.texts.right, c), this.texts.right);
  }

  /**
   * The revert buttons (») of the changes, in the middle as in IntelliJ: in the gutter of the right side,
   * at the line between the two sides. They take the left lane of the gutter; the commit check boxes of
   * the Changes tab take the right lane, so both show.
   */
  private renderRevert() {
    const right = this.editor.getModifiedEditor();
    const on = !!this.onRevert && this.notice.hidden && this.singleHost.hidden;
    this.revertKey?.set(on);
    const changes = on ? this.editor.getLineChanges() ?? [] : [];
    const last = right.getModel()?.getLineCount() ?? 1;
    // A change without lines on the right gets the button on the line after it.
    this.revertGlyphs = changes.map((c) => ({
      line: Math.min(last, Math.max(1, c.modifiedEndLineNumber === 0 ? c.modifiedStartLineNumber + 1 : c.modifiedStartLineNumber)),
      change: c,
    }));
    if (!this.selectable) right.updateOptions({ glyphMargin: changes.length > 0 });
    this.revertDeco = right.deltaDecorations(
      this.revertDeco,
      this.revertGlyphs.map((g) => ({
        range: new monaco.Range(g.line, 1, g.line, 1),
        options: {
          glyphMarginClassName: "revert-glyph",
          glyphMarginHoverMessage: { value: "Revert this change: the working tree gets the lines of the left side" },
          glyphMargin: { position: monaco.editor.GlyphMarginLane.Left, persistLane: true },
        },
      })),
    );
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
        ...editorFont(),
      });
      this.listenForBlameClicks(this.singleEditor);
      this.trackCursor(this.singleEditor);
    }
    return this.singleEditor;
  }

  applySettings() {
    this.applyOptions();
    this.editor.updateOptions(editorFont());
    this.singleEditor?.updateOptions(editorFont());
    for (const box of this.el.querySelectorAll<HTMLInputElement>(".diff-option input[data-key]")) box.checked = !!settings[box.dataset.key as "sideBySide"];
  }

  private applyOptions() {
    this.editor.updateOptions({
      renderSideBySide: settings.sideBySide,
      ignoreTrimWhitespace: settings.ignoreWhitespace,
      hideUnchangedRegions: { enabled: settings.collapseUnchanged },
    });
    // The revert buttons move with the layout.
    if (this.revertKey) this.renderRevert();
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

  /** Local changes: allows "Move Change to Another Changelist". Null turns it off. */
  setMoveChange(fn: ((line: number, at: { x: number; y: number }) => void) | null) {
    this.onMoveChange = fn;
    this.moveKey.set(!!fn);
  }

  /** Marks the changes that are in other changelists. Call it before show(). */
  setListHunks(hunks: { start: number; lines: number; label: string }[]) {
    this.listHunks = hunks;
    this.renderListHunks();
  }

  private renderListHunks() {
    const ed = this.editor.getModifiedEditor();
    const lineCount = ed.getModel()?.getLineCount() ?? 0;
    const deco: monaco.editor.IModelDeltaDecoration[] = [];
    if (this.notice.hidden && this.singleHost.hidden) {
      for (const x of this.listHunks) {
        // A change that only removes lines shows on the line after the removal.
        const start = Math.max(1, Math.min(lineCount, x.lines ? x.start : x.start + 1));
        const end = Math.max(start, Math.min(lineCount, x.lines ? x.start + x.lines - 1 : start));
        deco.push({
          range: new monaco.Range(start, 1, end, 1),
          options: {
            isWholeLine: true,
            className: "hunk-other-list",
            linesDecorationsClassName: "hunk-other-list-bar",
            hoverMessage: { value: `This change is in the changelist ${x.label}` },
          },
        });
      }
    }
    this.listDeco = ed.deltaDecorations(this.listDeco, deco);
  }

  /** Marks the lines that have review notes. show() clears them, so call it after show(). */
  setNotes(notes: { line: number; text: string }[]) {
    this.notes = notes;
    this.renderNotes();
  }

  /** The editor of the right side: the modified side, or the one editor of an added file. */
  private rightEditor(): monaco.editor.ICodeEditor {
    return this.singleHost.hidden ? this.editor.getModifiedEditor() : this.single;
  }

  private trackCursor(e: monaco.editor.ICodeEditor) {
    e.onDidChangeCursorPosition((ev) => {
      if (ev.source === "mouse" || ev.source === "keyboard") this.userPos = { line: ev.position.lineNumber, column: ev.position.column };
    });
  }

  /** The file of the right side, or "" when the view shows no file. */
  get currentPath(): string {
    return this.path;
  }

  /** Where Open in Editor goes: the cursor after the user moved it, else the first change on the screen,
   * else the first line on the screen. */
  editorPosition(): { line: number; column: number } {
    if (this.userPos) return this.userPos;
    const ed = this.rightEditor();
    const top = ed.getVisibleRanges()[0];
    if (!top) return { line: 1, column: 1 };
    const changes = this.singleHost.hidden ? (this.editor.getLineChanges() ?? []) : [];
    const first = changes.map((c) => Math.max(1, c.modifiedStartLineNumber)).find((l) => l >= top.startLineNumber && l <= top.endLineNumber);
    return { line: first ?? top.startLineNumber, column: 1 };
  }

  openInEditor() {
    if (!this.path) return;
    const p = this.editorPosition();
    this.onOpenInEditor(this.path, p.line, p.column);
  }

  /** The line of the cursor on the right side, 1-based. */
  cursorLine(): number {
    return this.rightEditor().getPosition()?.lineNumber ?? 1;
  }

  revealLine(line: number) {
    const ed = this.rightEditor();
    ed.revealLineInCenter(line);
    ed.setPosition({ lineNumber: line, column: 1 });
    this.userPos = { line, column: 1 };
  }

  private renderNotes() {
    const deco = (ed: monaco.editor.ICodeEditor): monaco.editor.IModelDeltaDecoration[] => {
      const count = ed.getModel()?.getLineCount() ?? 0;
      return this.notes
        .filter((n) => n.line >= 1 && n.line <= count)
        .map((n) => ({
          range: new monaco.Range(n.line, 1, n.line, 1),
          options: { isWholeLine: true, className: "review-note-line", linesDecorationsClassName: "review-note-bar", hoverMessage: { value: n.text } },
        }));
    };
    const onSingle = !this.singleHost.hidden;
    this.noteDeco = this.editor.getModifiedEditor().deltaDecorations(this.noteDeco, onSingle ? [] : deco(this.editor.getModifiedEditor()));
    if (this.singleEditor) this.singleNoteDeco = this.singleEditor.deltaDecorations(this.singleNoteDeco, onSingle ? deco(this.singleEditor) : []);
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
          glyphMargin: { position: monaco.editor.GlyphMarginLane.Right, persistLane: true },
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
    this.userPos = null;
    this.sides.textContent = "";
    this.title.textContent = title;
    this.stats.textContent = "";
    this.notice.textContent = text;
    this.notice.hidden = false;
    this.setModels("", "", undefined);
  }

  show(change: Change, left: FileContent, right: FileContent) {
    this.clearBlame();
    this.notes = [];
    queueMicrotask(() => void this.annotate());
    // The same file again (for example after it changed on disk): keep the scroll position.
    const same = change.path === this.path && this.notice.hidden && this.singleHost.hidden;
    this.keepView = same ? this.editor.getModifiedEditor().saveViewState() : null;
    this.revealFirst = !same;
    if (!same) this.userPos = null;
    this.path = change.path;
    this.title.replaceChildren(
      h("span", { class: `status status-${change.status}`, title: statusName(change.status) }, change.status),
      " ",
      change.old_path ? `${change.old_path} → ${change.path}` : change.path,
    );
    // A submodule, or a Git LFS object that is not downloaded.
    const note = left.note ?? right.note;
    if (note) this.title.append(h("span", { class: "muted-inline diff-note" }, ` · ${note}`));
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
    this.texts = { left: a, right: b };
    this.host.hidden = false;
    this.singleHost.hidden = true;
    const old = this.editor.getModel();
    this.editor.setModel({ original: monaco.editor.createModel(a, lang), modified: monaco.editor.createModel(b, lang) });
    // A diff of the old models can still run in the worker. It fails with "no diff result available"
    // when its models are gone, so they go a little later.
    if (old) setTimeout(() => {
      old.original.dispose();
      old.modified.dispose();
    }, 3000);
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
