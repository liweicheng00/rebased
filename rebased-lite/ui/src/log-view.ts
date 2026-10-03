// Virtualized commit log: a header, then one row per commit with the graph, refs, subject, author, date and hash.

import { api, type Row } from "./api";
import { dragResize, formatDate, h } from "./dom";
import { ELEMENT_WIDTH, ROW_HEIGHT, maxPosition, paintRow } from "./graph-paint";
import { save, settings } from "./settings";

const CHUNK = 200;
const OVERSCAN = 40;
const MAX_GRAPH_LANES = 40;

export class LogView {
  readonly el: HTMLElement;
  private header: HTMLElement;
  private scroller: HTMLElement;
  private spacer: HTMLElement;
  private body: HTMLElement;
  private empty: HTMLElement;
  private rowCount = 0;
  private chunks = new Map<number, Row[] | Promise<Row[]>>();
  private generation = 0;
  private graphLanes = 1;
  private paintKey = "";
  private rendered = new Map<number, { div: HTMLElement; selected: boolean }>();
  /** Selected rows in click order. */
  selection: number[] = [];
  private anchor = -1;
  onSelectionChange: (rows: Row[]) => void = () => {};
  onContextMenu: (row: Row, e: MouseEvent) => void = () => {};
  onRowsLoaded: (rows: Row[]) => void = () => {};
  onExpandEdge: (up: number, down: number) => void = () => {};
  onCollapseAll: () => void = () => {};
  onExpandAll: () => void = () => {};
  private collapsed = false;

  constructor() {
    this.header = h("div", { class: "log-header" });
    this.scroller = h("div", { class: "log-scroll", tabIndex: 0 });
    this.body = h("div", { class: "log-body" });
    this.spacer = h("div", { class: "log-spacer" }, this.body);
    this.empty = h("div", { class: "log-empty", hidden: true }, "No commits match the filter.");
    this.scroller.append(this.spacer);
    this.el = h("div", { class: "log" }, this.header, this.scroller, this.empty);
    this.scroller.addEventListener("scroll", () => this.render());
    new ResizeObserver(() => this.render()).observe(this.scroller);
    this.scroller.addEventListener("keydown", (e) => this.onKey(e));
    this.buildHeader();
  }

  focus() {
    this.scroller.focus();
  }

  buildHeader() {
    const col = (cls: string, label: string, key?: "authorWidth" | "dateWidth") => {
      const c = h("div", { class: `hcol ${cls}` }, label);
      if (key) {
        c.style.flexBasis = `${settings[key]}px`;
        const grip = h("div", { class: "hgrip" });
        let start = 0;
        dragResize(grip, "x", () => (start = settings[key]), (d) => {
          settings[key] = Math.max(60, Math.min(400, start - d));
          this.applyColumnWidths();
        }, save);
        c.prepend(grip);
      }
      return c;
    };
    const collapse = h("button", { class: "icon-button", title: "Collapse all linear branches" }, "⊟");
    const expand = h("button", { class: "icon-button", title: "Expand all linear branches", disabled: !this.collapsed }, "⊞");
    collapse.addEventListener("click", () => this.onCollapseAll());
    expand.addEventListener("click", () => this.onExpandAll());
    this.header.replaceChildren(
      h("div", { class: "hcol graph-tools" }, collapse, expand),
      col("subject", "Subject"),
      settings.showAuthor ? col("author", "Author", "authorWidth") : "",
      settings.showDate ? col("date", "Date", "dateWidth") : "",
      settings.showHash ? col("hash", "Hash") : "",
    );
    this.applyColumnWidths();
    this.paintKey = "";
    this.render();
  }

  private applyColumnWidths() {
    this.el.style.setProperty("--author-w", `${settings.authorWidth}px`);
    this.el.style.setProperty("--date-w", `${settings.dateWidth}px`);
    this.header.querySelector<HTMLElement>(".author")?.style.setProperty("flex-basis", `${settings.authorWidth}px`);
    this.header.querySelector<HTMLElement>(".date")?.style.setProperty("flex-basis", `${settings.dateWidth}px`);
  }

  setCollapsed(c: boolean) {
    if (this.collapsed === c) return;
    this.collapsed = c;
    this.buildHeader();
  }

  reset(rowCount: number, recommendedWidth: number, keepScroll = false) {
    this.generation++;
    this.rowCount = rowCount;
    this.chunks.clear();
    this.selection = [];
    this.anchor = -1;
    this.graphLanes = Math.max(1, Math.min(recommendedWidth, MAX_GRAPH_LANES));
    this.spacer.style.height = `${rowCount * ROW_HEIGHT}px`;
    this.empty.hidden = rowCount > 0;
    if (!keepScroll) this.scroller.scrollTop = 0;
    this.paintKey = "";
    this.render();
  }

  get count() {
    return this.rowCount;
  }

  private chunk(index: number): Row[] | null {
    const c = this.chunks.get(index);
    if (Array.isArray(c)) return c;
    if (!c) {
      const gen = this.generation;
      const p = api.rows(index * CHUNK, (index + 1) * CHUNK).then((rows) => {
        if (gen !== this.generation) return rows;
        this.chunks.set(index, rows);
        this.onRowsLoaded(rows);
        if (this.chunks.size > 60) this.evict(index);
        this.render();
        return rows;
      });
      this.chunks.set(index, p);
    }
    return null;
  }

  private evict(keep: number) {
    for (const k of [...this.chunks.keys()]) if (Math.abs(k - keep) > 20) this.chunks.delete(k);
  }

  row(index: number): Row | null {
    const c = this.chunk(Math.floor(index / CHUNK));
    return c ? (c[index % CHUNK] ?? null) : null;
  }

  /** Loads a row even when it is off screen. */
  async rowAsync(index: number): Promise<Row | null> {
    const i = Math.floor(index / CHUNK);
    this.chunk(i);
    const c = await this.chunks.get(i);
    return c ? (c[index % CHUNK] ?? null) : null;
  }

  private foreground(): string {
    return getComputedStyle(this.el).getPropertyValue("--fg").trim() || "#000";
  }

  render() {
    const top = this.scroller.scrollTop;
    const height = this.scroller.clientHeight;
    const start = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
    const end = Math.min(this.rowCount, Math.ceil((top + height) / ROW_HEIGHT) + OVERSCAN);
    const rows: Row[] = [];
    for (let i = start; i < end; i++) {
      const r = this.row(i);
      if (r) rows.push(r);
    }
    let lanes = this.graphLanes;
    for (const r of rows) lanes = Math.max(lanes, Math.min(maxPosition(r.elements) + 1, MAX_GRAPH_LANES));
    const fg = this.foreground();
    const dpr = window.devicePixelRatio || 1;
    const key = `${lanes}|${fg}|${dpr}|${this.generation}|${settings.showAuthor}${settings.showDate}${settings.showHash}`;
    if (key !== this.paintKey) {
      this.paintKey = key;
      this.graphLanes = lanes;
      this.rendered.clear();
      this.body.replaceChildren();
    }
    const selected = new Set(this.selection);
    const keep = new Set<number>();
    for (const r of rows) {
      keep.add(r.row);
      const isSel = selected.has(r.row);
      const existing = this.rendered.get(r.row);
      if (existing && existing.selected === isSel) continue;
      const div = this.buildRow(r, lanes * ELEMENT_WIDTH + 6, fg, dpr, isSel);
      if (existing) existing.div.replaceWith(div);
      else this.body.append(div);
      this.rendered.set(r.row, { div, selected: isSel });
    }
    for (const [row, v] of this.rendered) {
      if (!keep.has(row)) {
        v.div.remove();
        this.rendered.delete(row);
      }
    }
  }

  private buildRow(r: Row, graphWidth: number, fg: string, dpr: number, selected: boolean): HTMLElement {
    const canvas = h("canvas", { width: graphWidth * dpr, height: ROW_HEIGHT * dpr });
    canvas.style.width = `${graphWidth}px`;
    canvas.style.height = `${ROW_HEIGHT}px`;
    const g = canvas.getContext("2d")!;
    g.scale(dpr, dpr);
    paintRow(g, r.elements, fg, selected);
    const arrows = r.elements.filter((e) => e.j !== undefined);
    const collapsedEdges = r.elements.filter((e) => e.x !== undefined);
    if (arrows.length || collapsedEdges.length) {
      canvas.addEventListener("mousedown", (e) => {
        const lane = Math.floor(e.offsetX / ELEMENT_WIDTH);
        const fold = collapsedEdges.find((a) => a.p === lane || a.o === lane);
        if (fold?.x && e.button === 0) {
          e.stopPropagation();
          this.onExpandEdge(fold.x[0], fold.x[1]);
          return;
        }
        const hit = arrows.find((a) => a.p === lane || a.o === lane);
        if (hit && hit.j !== undefined && e.button === 0) {
          e.stopPropagation();
          this.jumpTo(hit.j, true);
        }
      });
      canvas.title = collapsedEdges.length
        ? "Click the dotted edge to expand the collapsed branch"
        : "Click an arrow to go to the other end of the edge";
      if (collapsedEdges.length) canvas.style.cursor = "pointer";
    }
    const subject = h("span", { class: "subject", title: r.subject });
    for (const ref of r.refs) subject.append(h("span", { class: `ref ref-${ref.kind}`, title: ref.name }, ref.name));
    subject.append(h("span", { class: "subject-text" }, r.subject));
    const div = h(
      "div",
      { class: "log-row" + (selected ? " selected" : "") + (r.isHead ? " head" : ""), "data-row": r.row },
      canvas,
      subject,
      settings.showAuthor ? h("span", { class: "author", title: `${r.author} <${r.authorEmail}>` }, r.author) : "",
      settings.showDate ? h("span", { class: "date" }, formatDate(r.authorTime)) : "",
      settings.showHash ? h("span", { class: "hash" }, r.oid.slice(0, 8)) : "",
    );
    div.style.top = `${r.row * ROW_HEIGHT}px`;
    div.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      // The click draws the rows again, so this row goes away. The default action of the mousedown
      // then has no row to focus and moves the focus to the body, and the arrow keys stop. onClick
      // focuses the list itself.
      e.preventDefault();
      this.onClick(r.row, e);
    });
    div.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (!this.selection.includes(r.row)) this.select([r.row]);
      this.onContextMenu(r, e);
    });
    return div;
  }

  select(rows: number[], anchor = rows[0] ?? -1) {
    this.selection = rows;
    this.anchor = anchor;
    this.changed();
  }

  /** Scrolls to a row; with `select`, the row becomes the selection. */
  jumpTo(row: number, select: boolean) {
    if (row < 0 || row >= this.rowCount) return;
    const y = row * ROW_HEIGHT;
    const view = this.scroller.clientHeight;
    if (y < this.scroller.scrollTop || y + ROW_HEIGHT > this.scroller.scrollTop + view) {
      this.scroller.scrollTop = Math.max(0, y - view / 3);
    }
    if (select) this.select([row]);
    this.focus();
  }

  private onClick(row: number, e: MouseEvent) {
    if (e.metaKey || e.ctrlKey) {
      const i = this.selection.indexOf(row);
      if (i >= 0) this.selection.splice(i, 1);
      else this.selection.push(row);
      this.anchor = row;
    } else if (e.shiftKey && this.anchor >= 0) {
      const [a, b] = [Math.min(this.anchor, row), Math.max(this.anchor, row)];
      this.selection = Array.from({ length: b - a + 1 }, (_, i) => a + i);
    } else {
      this.selection = [row];
      this.anchor = row;
    }
    this.focus();
    this.changed();
  }

  private onKey(e: KeyboardEvent) {
    const page = Math.max(1, Math.floor(this.scroller.clientHeight / ROW_HEIGHT) - 1);
    const cur = this.selection[this.selection.length - 1] ?? -1;
    const moves: Record<string, number> = {
      ArrowDown: cur + 1,
      ArrowUp: cur - 1,
      PageDown: cur + page,
      PageUp: cur - page,
      Home: 0,
      End: this.rowCount - 1,
    };
    if (!(e.key in moves) || this.rowCount === 0) return;
    e.preventDefault();
    const next = Math.max(0, Math.min(this.rowCount - 1, moves[e.key]));
    if (e.shiftKey && this.anchor >= 0) {
      const [a, b] = [Math.min(this.anchor, next), Math.max(this.anchor, next)];
      this.selection = Array.from({ length: b - a + 1 }, (_, i) => a + i);
      if (this.selection[this.selection.length - 1] !== next) this.selection.reverse();
      this.changed();
    } else {
      this.anchor = next;
      this.selection = [next];
      this.changed();
    }
    const y = next * ROW_HEIGHT;
    if (y < this.scroller.scrollTop) this.scroller.scrollTop = y;
    else if (y + ROW_HEIGHT > this.scroller.scrollTop + this.scroller.clientHeight) {
      this.scroller.scrollTop = y + ROW_HEIGHT - this.scroller.clientHeight;
    }
  }

  private selectionTimer = 0;

  /** The selected rows now, sorted top to bottom. It does not wait for the selection debounce. */
  async selectedRows(): Promise<Row[]> {
    const rows = await Promise.all([...this.selection].sort((a, b) => a - b).map((i) => this.rowAsync(i)));
    return rows.filter((r): r is Row => r !== null);
  }

  private changed() {
    this.render();
    // Wait a moment so fast keyboard navigation does not start a compare for every row.
    clearTimeout(this.selectionTimer);
    this.selectionTimer = window.setTimeout(async () => {
      const rows = await Promise.all([...this.selection].sort((a, b) => a - b).map((i) => this.rowAsync(i)));
      this.onSelectionChange(rows.filter((r): r is Row => r !== null));
    }, 60);
  }
}
