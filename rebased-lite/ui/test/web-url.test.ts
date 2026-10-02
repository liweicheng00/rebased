import assert from "node:assert/strict";
import { test } from "node:test";
import { branchUrl, commitUrl, webUrl } from "../src/web-url.ts";

test("remote URLs become web URLs", () => {
  assert.equal(webUrl("git@github.com:owner/repo.git"), "https://github.com/owner/repo");
  assert.equal(webUrl("https://github.com/owner/repo.git"), "https://github.com/owner/repo");
  assert.equal(webUrl("https://user:token@github.com/owner/repo"), "https://github.com/owner/repo");
  assert.equal(webUrl("ssh://git@gitlab.example.com:2222/group/sub/repo.git"), "https://gitlab.example.com/group/sub/repo");
  assert.equal(webUrl("http://git.local:3000/team/repo.git/"), "http://git.local:3000/team/repo");
  assert.equal(webUrl("git@ssh.dev.azure.com:v3/org/project/repo"), "https://dev.azure.com/org/project/_git/repo");
  assert.equal(webUrl("/srv/git/repo.git"), null);
  assert.equal(webUrl("file:///srv/git/repo.git"), null);
  assert.equal(webUrl("C:\\repos\\x.git"), null);
});

test("branch and commit pages per host", () => {
  assert.equal(branchUrl("https://github.com/o/r", "feat/x y"), "https://github.com/o/r/tree/feat/x%20y");
  assert.equal(branchUrl("https://gitlab.com/o/r", "main"), "https://gitlab.com/o/r/-/tree/main");
  assert.equal(branchUrl("https://bitbucket.org/o/r", "main"), "https://bitbucket.org/o/r/src/main");
  assert.equal(branchUrl("https://dev.azure.com/org/p/_git/r", "feat/x"), "https://dev.azure.com/org/p/_git/r?version=GBfeat%2Fx");
  assert.equal(commitUrl("https://github.com/o/r", "abc"), "https://github.com/o/r/commit/abc");
  assert.equal(commitUrl("https://gitlab.com/o/r", "abc"), "https://gitlab.com/o/r/-/commit/abc");
  assert.equal(commitUrl("https://bitbucket.org/o/r", "abc"), "https://bitbucket.org/o/r/commits/abc");
});
