// Line diff (Myers) and the three-way chunks of a merge: base, yours and theirs.

/** Lines `a[a0, a1)` are replaced by lines `b[b0, b1)`. */
export interface Hunk {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

/** The changed line ranges between `a` and `b`, in order. */
export function diffLines(a: string[], b: string[]): Hunk[] {
  // Common prefix and suffix make the search space small for the usual case.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const hunks = myers(A, B);
  return hunks.map((h) => ({ a0: h.a0 + pre, a1: h.a1 + pre, b0: h.b0 + pre, b1: h.b1 + pre }));
}

function myers(a: string[], b: string[]): Hunk[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0) return [{ a0: 0, a1: n, b0: 0, b1: m }];
  const max = n + m;
  const off = max;
  let v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  trace.push(v.slice());
  // Walk back through the trace to get the edit path.
  const edits: [number, number, number, number][] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 2; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[off + k - 1] < vd[off + k + 1]) ? k + 1 : k - 1;
    const prevX = vd[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
    }
    if (d > 0) edits.push([prevX, x, prevY, y]);
    x = prevX;
    y = prevY;
  }
  edits.reverse();
  // Join single-line edits into hunks.
  const hunks: Hunk[] = [];
  for (const [px, cx, py, cy] of edits) {
    const h = { a0: px, a1: cx, b0: py, b1: cy };
    const last = hunks[hunks.length - 1];
    if (last && last.a1 === h.a0 && last.b1 === h.b0) {
      last.a1 = h.a1;
      last.b1 = h.b1;
    } else {
      hunks.push(h);
    }
  }
  return hunks;
}

export type ChunkKind = "same" | "ours" | "theirs" | "both" | "conflict";

/** A region of the merge. Ranges are `[start, end)` line indexes in each version. */
export interface Chunk {
  kind: ChunkKind;
  base: [number, number];
  ours: [number, number];
  theirs: [number, number];
}

/**
 * The chunks of a three-way merge. A change on one side only is `ours` or `theirs`. The same change on
 * both sides is `both`. Different changes that overlap or touch are a `conflict`, as in git.
 */
export function merge3(base: string[], ours: string[], theirs: string[]): Chunk[] {
  const A = diffLines(base, ours).map((h) => ({ ...h, side: 0 }));
  const B = diffLines(base, theirs).map((h) => ({ ...h, side: 1 }));
  const all = [...A, ...B].sort((x, y) => x.a0 - y.a0 || x.a1 - y.a1);
  const chunks: Chunk[] = [];
  let pos = 0; // base line
  let dA = 0; // ours line minus base line, before the current position
  let dB = 0;
  let i = 0;
  while (i < all.length) {
    // A group: hunks whose base ranges overlap or touch.
    const group = [all[i]];
    let g0 = all[i].a0;
    let g1 = all[i].a1;
    i++;
    while (i < all.length && all[i].a0 <= g1) {
      group.push(all[i]);
      g1 = Math.max(g1, all[i].a1);
      g0 = Math.min(g0, all[i].a0);
      i++;
    }
    if (g0 > pos) chunks.push({ kind: "same", base: [pos, g0], ours: [pos + dA, g0 + dA], theirs: [pos + dB, g0 + dB] });
    const inA = group.filter((h) => h.side === 0);
    const inB = group.filter((h) => h.side === 1);
    const growA = inA.reduce((s, h) => s + (h.b1 - h.b0) - (h.a1 - h.a0), 0);
    const growB = inB.reduce((s, h) => s + (h.b1 - h.b0) - (h.a1 - h.a0), 0);
    const o: [number, number] = [g0 + dA, g1 + dA + growA];
    const t: [number, number] = [g0 + dB, g1 + dB + growB];
    let kind: ChunkKind;
    if (!inB.length) kind = "ours";
    else if (!inA.length) kind = "theirs";
    else kind = sameLines(ours, o, theirs, t) ? "both" : "conflict";
    chunks.push({ kind, base: [g0, g1], ours: o, theirs: t });
    dA += growA;
    dB += growB;
    pos = g1;
  }
  if (pos < base.length || chunks.length === 0) {
    chunks.push({ kind: "same", base: [pos, base.length], ours: [pos + dA, base.length + dA], theirs: [pos + dB, base.length + dB] });
  }
  return chunks;
}

function sameLines(a: string[], ra: [number, number], b: string[], rb: [number, number]) {
  if (ra[1] - ra[0] !== rb[1] - rb[0]) return false;
  for (let i = 0; i < ra[1] - ra[0]; i++) if (a[ra[0] + i] !== b[rb[0] + i]) return false;
  return true;
}

/** Splits text into lines. The text "a\nb\n" gives ["a", "b", ""], so joining with "\n" gives it back. */
export function splitLines(text: string): string[] {
  return text.split("\n");
}
