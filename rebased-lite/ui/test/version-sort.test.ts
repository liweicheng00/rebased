import assert from "node:assert/strict";
import { test } from "node:test";
import { compareTags } from "../src/version-sort.ts";

test("tags sort by version, newest first", () => {
  const tags = ["v1.9.0", "v1.10.0", "v1.0.0-rc.2", "v1.0.0", "v1.0.0-rc.10", "nightly", "backend/v1.0.0-rc.3", "backend/v1.1.0", "v2", "order/v1.1.0-rc.3"];
  assert.deepEqual(tags.sort(compareTags), [
    "v2",
    "v1.10.0",
    "v1.9.0",
    "v1.0.0",
    "v1.0.0-rc.10",
    "v1.0.0-rc.2",
    "backend/v1.1.0",
    "backend/v1.0.0-rc.3",
    "order/v1.1.0-rc.3",
    "nightly",
  ]);
});
