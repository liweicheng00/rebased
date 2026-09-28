// Unit tests for the line diff and the three-way chunks. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { diffLines, merge3, splitLines, type Chunk } from "../src/diff3.ts";

function apply(a: string[], b: string[]) {
  // Rebuilds b from a and the hunks.
  const out: string[] = [];
  let pos = 0;
  for (const h of diffLines(a, b)) {
    out.push(...a.slice(pos, h.a0), ...b.slice(h.b0, h.b1));
    pos = h.a1;
  }
  out.push(...a.slice(pos));
  return out;
}

test("diff rebuilds the target", () => {
  const cases: [string, string][] = [
    ["", ""],
    ["a", ""],
    ["", "a"],
    ["a b c", "a x c"],
    ["a b c d e f", "x a c d y f z"],
    ["1 2 3 4 5 6 7 8", "8 7 6 5 4 3 2 1"],
    ["a a a b b b", "b b b a a a"],
  ];
  for (const [x, y] of cases) {
    const a = x ? x.split(" ") : [];
    const b = y ? y.split(" ") : [];
    assert.deepEqual(apply(a, b), b, `${x} -> ${y}`);
  }
  // Random texts.
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 300; i++) {
    const a = Array.from({ length: Math.floor(rnd() * 30) }, () => "abcde"[Math.floor(rnd() * 5)]);
    const b = Array.from({ length: Math.floor(rnd() * 30) }, () => "abcde"[Math.floor(rnd() * 5)]);
    assert.deepEqual(apply(a, b), b);
  }
});

test("diff is minimal for a single change", () => {
  assert.deepEqual(diffLines(["a", "b", "c"], ["a", "x", "c"]), [{ a0: 1, a1: 2, b0: 1, b1: 2 }]);
  assert.deepEqual(diffLines(["a", "c"], ["a", "b", "c"]), [{ a0: 1, a1: 1, b0: 1, b1: 2 }]);
});

const kinds = (c: Chunk[]) => c.map((x) => x.kind).join(" ");

/** Merges by taking the changed side of every non-conflicting chunk, and base for conflicts. */
function autoMerge(base: string[], ours: string[], theirs: string[]) {
  const out: string[] = [];
  for (const c of merge3(base, ours, theirs)) {
    if (c.kind === "theirs") out.push(...theirs.slice(...c.theirs));
    else if (c.kind === "conflict") out.push("<<<", ...ours.slice(...c.ours), "===", ...theirs.slice(...c.theirs), ">>>");
    else out.push(...ours.slice(...c.ours));
  }
  return out;
}

test("merge3 kinds", () => {
  const base = splitLines("one\ntwo\nthree\nfour\nfive\n");
  const ours = splitLines("one\nTWO\nthree\nfour\nfive\n");
  const theirs = splitLines("one\ntwo\nthree\nfour\nFIVE\n");
  assert.equal(kinds(merge3(base, ours, theirs)), "same ours same theirs same");
  assert.deepEqual(autoMerge(base, ours, theirs), splitLines("one\nTWO\nthree\nfour\nFIVE\n"));

  const conflict = merge3(base, splitLines("one\nmine\nthree\nfour\nfive\n"), splitLines("one\nyours\nthree\nfour\nfive\n"));
  assert.equal(kinds(conflict), "same conflict same");
  assert.deepEqual(conflict[1], { kind: "conflict", base: [1, 2], ours: [1, 2], theirs: [1, 2] });

  const same = merge3(base, ours, ours);
  assert.equal(kinds(same), "same both same");

  // Adjacent changes conflict, as in git.
  assert.equal(kinds(merge3(base, splitLines("one\nTWO\nthree\nfour\nfive\n"), splitLines("one\ntwo\nTHREE\nfour\nfive\n"))), "same conflict same");

  // Insertions at the end and a deletion.
  const m = merge3(base, splitLines("one\ntwo\nthree\nfour\nfive\nsix\n"), splitLines("one\nthree\nfour\nfive\n"));
  assert.deepEqual(autoMerge(base, splitLines("one\ntwo\nthree\nfour\nfive\nsix\n"), splitLines("one\nthree\nfour\nfive\n")), splitLines("one\nthree\nfour\nfive\nsix\n"));
  assert.equal(kinds(m), "same theirs same ours same");
});

test("merge3 with empty sides", () => {
  assert.equal(kinds(merge3([""], ["a", ""], ["b", ""])), "conflict same");
  assert.equal(kinds(merge3([], [], [])), "same");
  assert.deepEqual(autoMerge([], ["x"], []), ["x"]);
});

test("merge3 ranges are consistent", () => {
  let seed = 11;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const mutate = (a: string[]) => a.flatMap((l) => (rnd() < 0.15 ? [] : rnd() < 0.15 ? [l, "n" + Math.floor(rnd() * 9)] : rnd() < 0.1 ? ["c" + l] : [l]));
  for (let i = 0; i < 300; i++) {
    const base = Array.from({ length: Math.floor(rnd() * 25) }, (_, j) => "l" + j);
    const ours = mutate(base);
    const theirs = mutate(base);
    const chunks = merge3(base, ours, theirs);
    let b = 0, o = 0, t = 0;
    for (const c of chunks) {
      assert.equal(c.base[0], b);
      assert.equal(c.ours[0], o);
      assert.equal(c.theirs[0], t);
      if (c.kind === "same") {
        assert.deepEqual(ours.slice(...c.ours), base.slice(...c.base));
        assert.deepEqual(theirs.slice(...c.theirs), base.slice(...c.base));
      }
      if (c.kind === "ours") assert.deepEqual(theirs.slice(...c.theirs), base.slice(...c.base));
      if (c.kind === "theirs") assert.deepEqual(ours.slice(...c.ours), base.slice(...c.base));
      [b, o, t] = [c.base[1], c.ours[1], c.theirs[1]];
    }
    assert.deepEqual([b, o, t], [base.length, ours.length, theirs.length]);
  }
});
