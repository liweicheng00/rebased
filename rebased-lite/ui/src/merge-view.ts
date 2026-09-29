// The three-way merge window, as in IntelliJ: yours on the left, the result in the middle, theirs on the right.
// The result starts as the base version. Apply (» or «) or ignore (✕) each change, or apply all
// non-conflicting changes at once. The result stays editable.

import * as monaco from "./monaco";
import { languageFor } from "./diff-view";
import { merge3, splitLines, type Chunk } from "./diff3";
import { h } from "./dom";

export interface MergeInput {
  path: string;
  base: string | null;
  ours: string | null;
  theirs: string | null;
  oursLabel: string;
  theirsLabel: string;
}

export type MergeOutcome = { kind: "save"; text: string } | { kind: "side"; side: "ours" | "theirs" } | { kind: "cancel" };

interface MChunk extends Chunk {
  /** The range of this chunk in the result, in lines. */
  res: [number, number];
  applied: ("ours" | "theirs")[];
  ignored: boolean;
}

const resolved = (c: MChunk) => c.kind === "same" || c.ignored || c.applied.length > 0;

/** Opens the merge window and resolves when the user closes it. */
export function openMergeTool(input: MergeInput): Promise<MergeOutcome> {
  return new Promise((resolve) => new MergeWindow(input, resolve));
}

class MergeWindow {
  private overlay: HTMLElement;
  private ours: monaco.editor.IStandaloneCodeEditor;
  private result: monaco.editor.IStandaloneCodeEditor;
  private theirs: monaco.editor.IStandaloneCodeEditor;
  private models: monaco.editor.ITextModel[] = [];
  private oursLines: string[];
  private theirsLines: string[];
  private chunks: MChunk[];
  private deco = { ours: [] as string[], result: [] as string[], theirs: [] as string[] };
  private zones = { ours: [] as string[], result: [] as string[], theirs: [] as string[] };
  private suppress = false;
  private syncing = false;
  private dirty = false;
  private status: HTMLElement;
  private current = -1;
  private refreshTimer = 0;

  constructor(input: MergeInput, private done: (o: MergeOutcome) => void) {
    const base = input.base ?? "";
    const oursText = input.ours ?? "";
    const theirsText = input.theirs ?? "";
    this.oursLines = splitLines(oursText);
    this.theirsLines = splitLines(theirsText);
    const baseLines = splitLines(base);
    this.chunks = merge3(baseLines, this.oursLines, this.theirsLines).map((c) => ({ ...c, res: [c.base[0], c.base[1]], applied: [], ignored: false }));

    const lang = languageFor(input.path);
    const btn = (label: string, title: string, run: () => void, cls = "") => {
      const b = h("button", { class: "tb-button " + cls, title }, label);
      b.addEventListener("click", run);
      return b;
    };
    this.status = h("span", { class: "merge-status" });
    const oursHost = h("div", { class: "merge-editor" });
    const resultHost = h("div", { class: "merge-editor" });
    const theirsHost = h("div", { class: "merge-editor" });
    const title = (label: string, text: string | null, cls: string) =>
      h("div", { class: "merge-col-title " + cls, title: label }, label + (text === null ? " (deleted)" : ""));
    const win = h(
      "div",
      { class: "merge-window", role: "dialog", "aria-label": `Merge ${input.path}` },
      h("div", { class: "merge-header" }, h("b", {}, "Merge Revisions for "), h("code", {}, input.path)),
      h(
        "div",
        { class: "merge-toolbar" },
        btn("↑", "Previous change (Shift+F7)", () => this.go(-1)),
        btn("↓", "Next change (F7)", () => this.go(1)),
        h("span", { class: "merge-sep" }),
        h("span", { class: "muted-inline" }, "Apply non-conflicting changes:"),
        btn("« Left", "Apply the non-conflicting changes from yours", () => this.applyNonConflicting("ours")),
        btn("All", "Apply all non-conflicting changes", () => this.applyNonConflicting("all"), "merge-all"),
        btn("Right »", "Apply the non-conflicting changes from theirs", () => this.applyNonConflicting("theirs")),
        h("span", { class: "spacer" }),
        this.status,
      ),
      h(
        "div",
        { class: "merge-titles" },
        title(input.oursLabel, input.ours, "ours"),
        h("div", { class: "merge-col-title result" }, "Result"),
        title(input.theirsLabel, input.theirs, "theirs"),
      ),
      h("div", { class: "merge-editors" }, oursHost, resultHost, theirsHost),
      h(
        "div",
        { class: "merge-footer" },
        btn("Accept Yours", "Take your whole version and close", () => this.close({ kind: "side", side: "ours" })),
        btn("Accept Theirs", "Take their whole version and close", () => this.close({ kind: "side", side: "theirs" })),
        h("span", { class: "spacer" }),
        btn("Cancel", "Close without changes (Escape)", () => void this.cancel()),
        btn("Apply", "Save the result and mark the file resolved", () => void this.apply(), "primary"),
      ),
    );
    this.overlay = h("div", { class: "merge-overlay" }, win);
    document.body.append(this.overlay);

    const common: monaco.editor.IStandaloneEditorConstructionOptions = {
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      glyphMargin: true,
      folding: false,
      renderLineHighlight: "none",
      lineNumbersMinChars: 3,
      fontSize: 12,
      overviewRulerLanes: 0,
    };
    const model = (text: string) => {
      const m = monaco.editor.createModel(text, lang);
      this.models.push(m);
      return m;
    };
    this.ours = monaco.editor.create(oursHost, { ...common, model: model(oursText), readOnly: true });
    this.result = monaco.editor.create(resultHost, { ...common, model: model(base) });
    this.theirs = monaco.editor.create(theirsHost, { ...common, model: model(theirsText), readOnly: true });

    for (const e of [this.ours, this.result, this.theirs]) {
      e.onDidScrollChange((ev) => {
        if (this.syncing || !ev.scrollTopChanged) return;
        this.syncing = true;
        for (const o of [this.ours, this.result, this.theirs]) if (o !== e) o.setScrollTop(ev.scrollTop);
        this.syncing = false;
      });
      e.onMouseDown((ev) => {
        if (ev.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !ev.target.position) return;
        this.onGlyph(e, ev.target.position.lineNumber);
      });
    }
    this.result.onDidChangeModelContent((ev) => {
      if (this.suppress) return;
      this.dirty = true;
      const changes = [...ev.changes].sort((a, b) => b.range.startLineNumber - a.range.startLineNumber);
      for (const ch of changes) this.track(ch.range.startLineNumber - 1, ch.range.endLineNumber - 1, ch.text.split("\n").length - 1);
      clearTimeout(this.refreshTimer);
      this.refreshTimer = window.setTimeout(() => this.refresh(), 60);
    });
    this.overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void this.cancel();
      } else if (e.key === "F7") {
        e.preventDefault();
        this.go(e.shiftKey ? -1 : 1);
      }
    });
    this.refresh();
    requestAnimationFrame(() => {
      this.go(1);
      this.result.focus();
    });
  }

  /** Moves chunk ranges after a user edit of result lines [s, e] that added `added` line breaks. */
  private track(s: number, e: number, added: number) {
    const delta = added - (e - s);
    for (const c of this.chunks) {
      if (c.res[0] > e) {
        c.res = [c.res[0] + delta, c.res[1] + delta];
      } else if (c.res[1] > s || (c.res[0] === c.res[1] && c.res[0] > s)) {
        const start = Math.min(c.res[0], s);
        c.res = [start, Math.max(start, c.res[1] + delta)];
      }
    }
  }

  /** Replaces the result lines of a chunk. */
  private replace(c: MChunk, lines: string[]) {
    const m = this.result.getModel()!;
    const count = m.getLineCount();
    const [s, e] = c.res;
    let range: monaco.Range;
    let text: string;
    if (e < count) {
      range = new monaco.Range(s + 1, 1, e + 1, 1);
      text = lines.length ? lines.join("\n") + "\n" : "";
    } else if (s > 0) {
      // The chunk reaches the end of the text: remove the line break before it instead of after it.
      range = new monaco.Range(s, m.getLineMaxColumn(s), count, m.getLineMaxColumn(count));
      text = lines.length ? "\n" + lines.join("\n") : "";
    } else {
      range = new monaco.Range(1, 1, count, m.getLineMaxColumn(count));
      text = lines.join("\n");
    }
    this.suppress = true;
    m.pushEditOperations([], [{ range, text }], () => null);
    this.suppress = false;
    this.dirty = true;
    const delta = lines.length - (e - s);
    const i = this.chunks.indexOf(c);
    c.res = [s, s + lines.length];
    for (const o of this.chunks.slice(i + 1)) o.res = [o.res[0] + delta, o.res[1] + delta];
  }

  private applySide(c: MChunk, side: "ours" | "theirs") {
    if (c.applied.includes(side)) return;
    const lines = side === "ours" ? this.oursLines.slice(...c.ours) : this.theirsLines.slice(...c.theirs);
    if (c.applied.length) {
      // The other side is in the result already: append this side after it.
      const m = this.result.getModel()!;
      const current = splitLines(m.getValue()).slice(...c.res);
      this.replace(c, [...current, ...lines]);
    } else {
      this.replace(c, lines);
    }
    c.applied.push(side);
    this.refresh();
  }

  private ignore(c: MChunk) {
    c.ignored = true;
    this.dirty = true;
    this.refresh();
  }

  private applyNonConflicting(which: "ours" | "theirs" | "all") {
    for (const c of [...this.chunks]) {
      if (resolved(c) || c.kind === "conflict") continue;
      if (c.kind === "both" || (c.kind === "ours" && which !== "theirs")) this.applySide(c, "ours");
      else if (c.kind === "theirs" && which !== "ours") this.applySide(c, "theirs");
    }
    this.go(1);
  }

  private canApply(c: MChunk, side: "ours" | "theirs") {
    if (resolved(c) && !(c.kind === "conflict" && c.applied.length === 1 && !c.applied.includes(side))) return false;
    if (c.kind === "same") return false;
    return c.kind === "conflict" || c.kind === "both" || c.kind === side;
  }

  private glyphLine(range: [number, number], lineCount: number) {
    return Math.min(range[0] + 1, lineCount);
  }

  private onGlyph(e: monaco.editor.IStandaloneCodeEditor, line: number) {
    const side = e === this.ours ? "ours" : e === this.theirs ? "theirs" : null;
    const count = e.getModel()!.getLineCount();
    for (const c of this.chunks) {
      if (c.kind === "same") continue;
      if (side) {
        const range = side === "ours" ? c.ours : c.theirs;
        if (this.glyphLine(range, count) === line && this.canApply(c, side)) return this.applySide(c, side);
      } else if (this.glyphLine(c.res, count) === line && !resolved(c)) {
        return this.ignore(c);
      }
    }
  }

  private go(dir: number) {
    const open = this.chunks.map((c, i) => [c, i] as const).filter(([c]) => c.kind !== "same" && !resolved(c));
    const list = open.length ? open : this.chunks.map((c, i) => [c, i] as const).filter(([c]) => c.kind !== "same");
    if (!list.length) return;
    const next = dir > 0 ? list.find(([, i]) => i > this.current) ?? list[0] : [...list].reverse().find(([, i]) => i < this.current) ?? list[list.length - 1];
    this.current = next[1];
    const line = next[0].res[0] + 1;
    this.result.revealLineInCenter(Math.min(line, this.result.getModel()!.getLineCount()));
    this.refresh();
  }

  private refresh() {
    const lineDeco = (range: [number, number], kind: string, extra: string, count: number, glyph?: string, hover?: string): monaco.editor.IModelDeltaDecoration[] => {
      const out: monaco.editor.IModelDeltaDecoration[] = [];
      if (range[1] > range[0]) {
        out.push({
          range: new monaco.Range(range[0] + 1, 1, range[1], 1),
          options: { isWholeLine: true, className: `m-${kind} ${extra}`, linesDecorationsClassName: `m-${kind}-bar` },
        });
      } else {
        const l = Math.min(range[0] + 1, count);
        const gap = range[0] + 1 > count ? `m-${kind}-gap-after` : `m-${kind}-gap`;
        out.push({ range: new monaco.Range(l, 1, l, 1), options: { isWholeLine: true, className: `${gap} ${extra}` } });
      }
      if (glyph) {
        const l = this.glyphLine(range, count);
        out.push({ range: new monaco.Range(l, 1, l, 1), options: { glyphMarginClassName: glyph, glyphMarginHoverMessage: { value: hover ?? "" } } });
      }
      return out;
    };
    const o: monaco.editor.IModelDeltaDecoration[] = [];
    const r: monaco.editor.IModelDeltaDecoration[] = [];
    const t: monaco.editor.IModelDeltaDecoration[] = [];
    const oc = this.ours.getModel()!.getLineCount();
    const rc = this.result.getModel()!.getLineCount();
    const tc = this.theirs.getModel()!.getLineCount();
    let open = 0;
    let conflicts = 0;
    this.chunks.forEach((c, i) => {
      if (c.kind === "same") return;
      const done = resolved(c);
      if (!done) open++;
      if (!done && c.kind === "conflict") conflicts++;
      const cls = `${done ? "m-done" : ""}${i === this.current ? " m-current" : ""}`;
      if (c.kind !== "theirs") o.push(...lineDeco(c.ours, c.kind, cls, oc, this.canApply(c, "ours") ? "m-glyph-right" : undefined, c.applied.length ? "Append yours" : "Apply yours"));
      if (c.kind !== "ours") t.push(...lineDeco(c.theirs, c.kind, cls, tc, this.canApply(c, "theirs") ? "m-glyph-left" : undefined, c.applied.length ? "Append theirs" : "Apply theirs"));
      r.push(...lineDeco(c.res, c.kind, cls, rc, done ? undefined : "m-glyph-ignore", "Ignore this change"));
    });
    this.deco.ours = this.ours.deltaDecorations(this.deco.ours, o);
    this.deco.result = this.result.deltaDecorations(this.deco.result, r);
    this.deco.theirs = this.theirs.deltaDecorations(this.deco.theirs, t);
    this.align();
    this.status.textContent = open
      ? `${open} change${open === 1 ? "" : "s"} left${conflicts ? `, ${conflicts} conflict${conflicts === 1 ? "" : "s"}` : ""}`
      : "All changes are resolved";
    this.status.classList.toggle("done", open === 0);
  }

  /** Adds blank space under shorter chunks, so the three versions stay side by side. */
  private align() {
    const zonesFor = (e: monaco.editor.IStandaloneCodeEditor, key: "ours" | "result" | "theirs", pick: (c: MChunk) => [number, number]) => {
      e.changeViewZones((acc) => {
        for (const id of this.zones[key]) acc.removeZone(id);
        this.zones[key] = [];
        for (const c of this.chunks) {
          const heights = [c.ours[1] - c.ours[0], c.res[1] - c.res[0], c.theirs[1] - c.theirs[0]];
          const own = pick(c)[1] - pick(c)[0];
          const pad = Math.max(...heights) - own;
          if (pad > 0) this.zones[key].push(acc.addZone({ afterLineNumber: pick(c)[1], heightInLines: pad, domNode: h("div", { class: "m-zone" }) }));
        }
      });
    };
    zonesFor(this.ours, "ours", (c) => c.ours);
    zonesFor(this.result, "result", (c) => c.res);
    zonesFor(this.theirs, "theirs", (c) => c.theirs);
  }

  private async apply() {
    const open = this.chunks.filter((c) => !resolved(c)).length;
    if (open && !window.confirm(`${open} change(s) are not resolved. Save the result as it is?`)) return;
    this.close({ kind: "save", text: this.result.getModel()!.getValue() });
  }

  private async cancel() {
    if (this.dirty && !window.confirm("Close the merge window? Your changes to the result are lost.")) return;
    this.close({ kind: "cancel" });
  }

  private close(o: MergeOutcome) {
    clearTimeout(this.refreshTimer);
    for (const e of [this.ours, this.result, this.theirs]) e.dispose();
    for (const m of this.models) m.dispose();
    this.overlay.remove();
    this.done(o);
  }
}
