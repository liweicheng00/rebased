import assert from "node:assert/strict";
import { test } from "node:test";
import { pathLabels } from "../src/path-labels.ts";

test("unique folder names stay alone", () => {
  assert.deepEqual(pathLabels(["/home/u/rebased", "/home/u/rebased-wt"]), ["rebased", "rebased-wt"]);
});

test("the same name takes the folder above it", () => {
  assert.deepEqual(pathLabels(["/work/a/app", "/work/b/app", "/work/tool"]), ["a/app", "b/app", "tool"]);
});

test("more folders when the folder above is the same too", () => {
  assert.deepEqual(pathLabels(["/x/proj/wt/app", "/y/proj/wt/app"]), ["x/proj/wt/app", "y/proj/wt/app"]);
});

test("Windows paths and a trailing separator", () => {
  assert.deepEqual(pathLabels(["C:\\\\src\\\\one\\\\app\\\\", "D:\\\\two\\\\app"]), ["one/app", "two/app"]);
});
