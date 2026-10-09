import assert from "node:assert/strict";
import { test } from "node:test";
import { addIgnoreLine, globalPatterns } from "../src/ignore-patterns.ts";

test("a pattern goes on its own line at the end", () => {
  assert.equal(addIgnoreLine("", ".idea/"), ".idea/\n");
  assert.equal(addIgnoreLine("*.log", ".idea/"), "*.log\n.idea/\n");
  assert.equal(addIgnoreLine("*.log\n", ".idea/"), "*.log\n.idea/\n");
});

test("a pattern that is there stays once", () => {
  assert.equal(addIgnoreLine("*.log\r\n  .idea/  \n", ".idea/"), "*.log\r\n  .idea/  \n");
});

test("the patterns are the names of the files and folders", () => {
  assert.deepEqual(globalPatterns([".idea/", "app/.DS_Store", ".DS_Store", "a/b/build/"]), [".idea/", ".DS_Store", "build/"]);
});
