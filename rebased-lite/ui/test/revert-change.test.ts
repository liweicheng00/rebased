import assert from "node:assert/strict";
import { test } from "node:test";
import { revertChange } from "../src/revert-change.ts";

const change = (o1: number, o2: number, m1: number, m2: number) => ({ originalStartLineNumber: o1, originalEndLineNumber: o2, modifiedStartLineNumber: m1, modifiedEndLineNumber: m2 });

test("a changed line goes back", () => {
  assert.equal(revertChange("a\nb\nc\n", "a\nB\nc\n", change(2, 2, 2, 2)), "a\nb\nc\n");
});

test("an added line goes away, and other changes stay", () => {
  // Left a b c; right A b x c: two changes. Revert only the insert of x.
  assert.equal(revertChange("a\nb\nc\n", "A\nb\nx\nc\n", change(2, 0, 3, 3)), "A\nb\nc\n");
});

test("a deleted line comes back", () => {
  assert.equal(revertChange("a\nb\nc\n", "a\nc\n", change(2, 2, 1, 0)), "a\nb\nc\n");
  // At the start of the file.
  assert.equal(revertChange("a\nb\n", "b\n", change(1, 1, 0, 0)), "a\nb\n");
});

test("the end of the file follows the left side", () => {
  // Left has no line end at its end; right added a line after it.
  assert.equal(revertChange("a\nb", "a\nb\nc\n", change(2, 2, 2, 3)), "a\nb");
  // Right lost the last line, which had no line end.
  assert.equal(revertChange("a\nb", "a\n", change(2, 2, 1, 0)), "a\nb");
  // A line comes back after a last line without a line end.
  assert.equal(revertChange("a\nb\n", "a", change(2, 2, 1, 0)), "a\nb\n");
});

test("CRLF line ends stay", () => {
  assert.equal(revertChange("a\r\nb\r\n", "a\r\nB\r\nc\r\n", change(2, 2, 2, 3)), "a\r\nb\r\n");
  assert.equal(revertChange("a\r\nb\r\nc\r\n", "a\r\nc\r\n", change(2, 2, 1, 0)), "a\r\nb\r\nc\r\n");
});

test("a whole new file empties", () => {
  assert.equal(revertChange("", "x\ny\n", change(0, 0, 1, 2)), "");
});
