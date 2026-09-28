// Paints one graph cell. Port of IntelliJ `SimpleGraphCellPainter`, `PaintParameters` and
// `DefaultColorGenerator` (platform/vcs-log/impl, Apache-2.0).

import type { El } from "./api";

export const ROW_HEIGHT = 22;
export const ELEMENT_WIDTH = 15;
const ELEMENT_CENTER = 7.5;
const ROW_CENTER = 11;
const LINE_THICKNESS = 1.5;
const CIRCLE_RADIUS = 3.5;
const ARROW_ANGLE_COS2 = 0.7;
const ARROW_LENGTH = 0.3;

const colorCache = new Map<number, string>();

function rangeFix(n: number): number {
  return Math.abs(n % 100) + 70;
}

// java.awt.Color.RGBtoHSB, hue only
function hue(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === 0 || max === min) return 0;
  const d = max - min;
  const rc = (max - r) / d;
  const gc = (max - g) / d;
  const bc = (max - b) / d;
  let h = r === max ? bc - gc : g === max ? 2 + rc - bc : 4 + gc - rc;
  h /= 6;
  if (h < 0) h += 1;
  return h;
}

// java.awt.Color.HSBtoRGB
function hsbToRgb(h: number, s: number, v: number): string {
  const hh = (h - Math.floor(h)) * 6;
  const f = hh - Math.floor(hh);
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  const [r, g, b] = [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ][Math.floor(hh)];
  const c = (x: number) => Math.floor(x * 255 + 0.5);
  return `rgb(${c(r)}, ${c(g)}, ${c(b)})`;
}

/** Color for a color id. Id 0 is the default branch color; it follows the text color. */
export function graphColor(id: number, foreground: string): string {
  if (id === 0) return foreground;
  let c = colorCache.get(id);
  if (!c) {
    const r = Math.imul(id, 200) + 30;
    const g = Math.imul(id, 130) + 50;
    const b = Math.imul(id, 90) + 100;
    c = hsbToRgb(hue(rangeFix(r), rangeFix(g), rangeFix(b)), 0.4, 0.65);
    colorCache.set(id, c);
  }
  return c;
}

function rotate(x: number, y: number, cx: number, cy: number, cos: number, sin: number, len: number): [number, number] {
  const tx = x - cx;
  const ty = y - cy;
  const d = Math.hypot(tx, ty);
  const sx = (len * tx) / d;
  const sy = (len * ty) / d;
  return [sx * cos - sy * sin + cx, sx * sin + sy * cos + cy];
}

function dash(edgeLength: number): number[] {
  const count = Math.max(1, Math.floor(edgeLength / ROW_HEIGHT));
  const space = ROW_HEIGHT / 2 - 2;
  return [edgeLength / count - space, space];
}

function line(g: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, ax: number, ay: number, arrow: boolean, solid: boolean) {
  g.setLineDash(solid || arrow ? [] : dash(x1 === x2 ? ROW_HEIGHT : Math.hypot(x1 - x2, y1 - y2)));
  g.beginPath();
  g.moveTo(x1, y1);
  g.lineTo(x2, y2);
  if (arrow) {
    const len = ARROW_LENGTH * ROW_HEIGHT;
    const [e1x, e1y] = rotate(x1, y1, ax, ay, Math.sqrt(ARROW_ANGLE_COS2), Math.sqrt(1 - ARROW_ANGLE_COS2), len);
    const [e2x, e2y] = rotate(x1, y1, ax, ay, Math.sqrt(ARROW_ANGLE_COS2), -Math.sqrt(1 - ARROW_ANGLE_COS2), len);
    g.moveTo(ax, ay);
    g.lineTo(e1x, e1y);
    g.moveTo(ax, ay);
    g.lineTo(e2x, e2y);
  }
  g.stroke();
}

/** Paints the elements of one row with its top at y = 0. */
export function paintRow(g: CanvasRenderingContext2D, elements: El[], foreground: string, selected: boolean) {
  g.lineWidth = LINE_THICKNESS;
  g.lineCap = "round";
  for (const e of elements) {
    if (e.k !== "e") continue;
    g.strokeStyle = graphColor(e.c, foreground);
    const down = e.d === "d";
    const x1 = ELEMENT_WIDTH * e.p + ELEMENT_CENTER;
    if (e.p === e.o) {
      const gap = e.t ? CIRCLE_RADIUS / 2 + 1 : 0;
      const y2 = down ? ROW_HEIGHT - gap : gap;
      line(g, x1, ROW_CENTER, x1, y2, x1, y2, e.a, !e.s);
    } else {
      // Non-vertical lines are drawn twice as long so neighbouring rows dock; the canvas clips them.
      const x2 = ELEMENT_WIDTH * e.o + ELEMENT_CENTER;
      const y2 = down ? ROW_HEIGHT + ROW_CENTER : ROW_CENTER - ROW_HEIGHT;
      line(g, x1, ROW_CENTER, x2, y2, (x1 + x2) / 2, (ROW_CENTER + y2) / 2, e.a, !e.s);
    }
  }
  g.setLineDash([]);
  for (const e of elements) {
    if (e.k !== "n") continue;
    const r = selected ? CIRCLE_RADIUS + 1 : CIRCLE_RADIUS;
    g.fillStyle = graphColor(e.c, foreground);
    g.beginPath();
    g.arc(ELEMENT_WIDTH * e.p + ELEMENT_CENTER, ROW_CENTER, r, 0, Math.PI * 2);
    g.fill();
  }
}

export function maxPosition(elements: El[]): number {
  let m = 0;
  for (const e of elements) m = Math.max(m, e.p, e.o);
  return m;
}
