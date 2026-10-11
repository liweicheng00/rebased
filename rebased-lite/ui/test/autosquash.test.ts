import assert from "node:assert/strict";
import { test } from "node:test";
import { autosquash } from "../src/autosquash.ts";

const line = (oid: string, subject: string) => ({ oid, subject, action: "pick" });

test("a fixup goes after its commit, oldest first", () => {
  const out = autosquash([line("a1", "Add parser"), line("b2", "Add docs"), line("c3", "fixup! Add parser"), line("d4", "squash! Add docs")]);
  assert.deepEqual(out.map((l) => `${l.action} ${l.oid}`), ["pick a1", "fixup c3", "pick b2", "squash d4"]);
});

test("a fixup of a fixup and a hash prefix find the commit", () => {
  const out = autosquash([line("abcd1234", "Add parser"), line("b2", "fixup! fixup! Add parser"), line("c3", "fixup! abcd")]);
  assert.deepEqual(out.map((l) => `${l.action} ${l.oid}`), ["pick abcd1234", "fixup b2", "fixup c3"]);
});

test("a fixup without its commit stays", () => {
  const out = autosquash([line("a1", "Add parser"), line("b2", "fixup! Old work")]);
  assert.deepEqual(out.map((l) => `${l.action} ${l.oid}`), ["pick a1", "pick b2"]);
});
