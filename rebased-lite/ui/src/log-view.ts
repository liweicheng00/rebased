// Virtualized commit log: a graph column painted per row, then refs, subject, author and date.

import { api, type Row } from "./api";
import { ELEMENT_WIDTH, ROW_HEIGHT, maxPosition, paintRow } from "./graph-paint";

const CHUNK = 200;
const OVERSCAN = 50;
const MAX_GRAPH_LANES = 40;

export class LogView {
  readonly el: HTMLElement;
  private spacer: HTMLElement;
  private body: HTMLElement;
  private rowCount = 0;
  private chunks = new Map<number, Row[] | Promise<Row[]>>();
  private generation = 0;
  private graphLanes = 1;
  private paintKey = "";
  private rendered = new Map<number, { div: HTMLElement; selected: boolean }>();
  /** Selected rows in click order. */
  selection: number[] = [];
  onSelectionChange: (rows: Row[]) => void = () => {};

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "log";
    this.el.tabIndex = 0;
    this.spacer = document.createElement("div");
    this.spacer.className = "log-spacer";
    this.body = document.createElement("div");
    this.body.className = "log-body";
    this.spacer.append(this.body);
    this.el.append(this.spacer);
    this.el.addEventListener("scroll", () => this.render());
    new ResizeObserver(() => this.render()).observe(this.el);
    this.el.addEventListener("keydown", (e) => this.onKey(e));
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.render());
  }

  reset(rowCount: number, recommendedWidth: number) {
    this.generation++;
    this.rowCount = rowCount;
    this.chunks.clear();
    this.selection = [];
    this.graphLanes = Math.max(1, Math.min(recommendedWidth, MAX_GRAPH_LANES));
    this.spacer.style.height = `${rowCount * ROW_HEIGHT}px`;
    this.el.scrollTop = 0;
    this.render();
  }

  private chunk(index: number): Row[] | null {
    const c = this.chunks.get(index);
    if (Array.isArray(c)) return c;
    if (!c) {
      const gen = this.generation;
      const p = api.rows(index * CHUNK, (index + 1) * CHUNK).then((rows) => {
        if (gen !== this.generation) return rows;
        this.chunks.set(index, rows);
        if (this.chunks.size > 60) this.evict(index);
        this.render();
        return rows;
      });
      this.chunks.set(index, p);
    }
    return null;
  }

  private evict(keep: number) {
    for (const k of [...this.chunks.keys()]) {
      if (Math.abs(k - keep) > 20) this.chunks.delete(k);
    }
  }

  row(index: number): Row | null {
    const c = this.chunk(Math.floor(index / CHUNK));
    return c ? c[index % CHUNK] ?? null : null;
  }

  private foreground(): string {
    return getComputedStyle(this.el).getPropertyValue("--fg").trim() || "#000";
  }

  render() {
    const top = this.el.scrollTop;
    const height = this.el.clientHeight;
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
    const key = `${lanes}|${fg}|${dpr}|${this.generation}`;
    if (key !== this.paintKey) {
      // Graph width, colors or scale changed: rebuild every row.
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
    const div = document.createElement("div");
    div.className = "log-row" + (selected ? " selected" : "");
    div.style.top = `${r.row * ROW_HEIGHT}px`;
    div.dataset.row = String(r.row);
    const canvas = document.createElement("canvas");
    canvas.width = graphWidth * dpr;
    canvas.height = ROW_HEIGHT * dpr;
    canvas.style.width = `${graphWidth}px`;
    canvas.style.height = `${ROW_HEIGHT}px`;
    const g = canvas.getContext("2d")!;
    g.scale(dpr, dpr);
    paintRow(g, r.elements, fg, selected);
    const subject = document.createElement("span");
    subject.className = "subject";
    for (const ref of r.refs) {
      const label = document.createElement("span");
      label.className = `ref ref-${ref.kind}`;
      label.textContent = ref.name;
      subject.append(label);
    }
    subject.append(document.createTextNode(r.subject));
    subject.title = r.subject;
    const author = document.createElement("span");
    author.className = "author";
    author.textContent = r.author;
    const date = document.createElement("span");
    date.className = "date";
    date.textContent = r.authorTime ? formatDate(r.authorTime) : "";
    const hash = document.createElement("span");
    hash.className = "hash";
    hash.textContent = r.oid.slice(0, 8);
    div.append(canvas, subject, author, date, hash);
    div.addEventListener("mousedown", (e) => this.onClick(r.row, e));
    return div;
  }

  private onClick(row: number, e: MouseEvent) {
    if (e.metaKey || e.ctrlKey) {
      const i = this.selection.indexOf(row);
      if (i >= 0) this.selection.splice(i, 1);
      else this.selection.push(row);
    } else if (e.shiftKey && this.selection.length) {
      const anchor = this.selection[0];
      this.selection = [anchor, row];
    } else {
      this.selection = [row];
    }
    this.el.focus();
    this.changed();
  }

  private onKey(e: KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const cur = this.selection[this.selection.length - 1] ?? -1;
    const next = Math.max(0, Math.min(this.rowCount - 1, cur + (e.key === "ArrowDown" ? 1 : -1)));
    this.selection = [next];
    const y = next * ROW_HEIGHT;
    if (y < this.el.scrollTop) this.el.scrollTop = y;
    else if (y + ROW_HEIGHT > this.el.scrollTop + this.el.clientHeight) this.el.scrollTop = y + ROW_HEIGHT - this.el.clientHeight;
    this.changed();
  }

  private changed() {
    this.render();
    const rows = this.selection.map((i) => this.row(i)).filter((r): r is Row => r !== null);
    this.onSelectionChange(rows);
  }
}

function formatDate(seconds: number): string {
  const d = new Date(seconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
