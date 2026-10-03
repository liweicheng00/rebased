import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTree, treeOrder, walkTree } from "../src/file-tree.ts";

test("tree order and rows", () => {
  const paths = ["b.txt", "src/z.rs", "docs/a/x.md", "docs/a/y.md", "a.txt", "src/m/n.rs"].sort(treeOrder);
  assert.deepEqual(paths, ["docs/a/x.md", "docs/a/y.md", "src/m/n.rs", "src/z.rs", "a.txt", "b.txt"]);
  const rows: string[] = [];
  const tree = buildTree(paths.map((path, index) => ({ path, index })));
  walkTree(tree, new Set(["src/"]), {
    dir: (label, full, depth, open, count, viewed) => rows.push(`${"  ".repeat(depth)}${label}/ ${open ? "open" : "closed"} ${viewed}/${count}`),
    file: (i, depth) => rows.push(`${"  ".repeat(depth)}${paths[i]}`),
    viewed: (i) => i === 0,
  });
  // docs/a is one row: a folder with one child folder joins it.
  assert.deepEqual(rows, ["docs/a/ open 1/2", "  docs/a/x.md", "  docs/a/y.md", "src/ closed 0/2", "a.txt", "b.txt"]);
});
