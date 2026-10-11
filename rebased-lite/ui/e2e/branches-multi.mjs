// UI scenario for a multiple selection in the branches panel: Ctrl+click and Shift+click select, the menu
// of the selection filters the log, and Delete removes merged and unmerged branches and a tag with one
// question each. One Undo creates all of them again.
// Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh, then:
// node e2e/branches-multi.mjs <repo> <screenshot-dir>.
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
const [,, repo, outDir] = process.argv;
const git = (...args) => execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { encoding: "utf8" }).trim();
// Two merged branches, one unmerged branch and a tag.
git("branch", "old-1", "main");
git("branch", "old-2", "main");
git("branch", "wip", git("commit-tree", git("rev-parse", "main^{tree}"), "-p", "main", "-m", "Work in progress"));
git("tag", "-a", "-m", "Try", "try-1", "main");
const has = (full) => { try { git("rev-parse", "-q", "--verify", full); return true; } catch { return false; } };

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e));
const shot = async (name) => { await page.waitForTimeout(500); await page.screenshot({ path: `${outDir}/${name}.png` }); console.log("shot", name); };
const check = (what, ok) => { console.log(ok ? "ok  " : "FAIL", what); if (!ok) errors.push("check: " + what); };
const within = async (what, fn, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return check(what, true);
    await page.waitForTimeout(200);
  }
  check(what, false);
};
const local = (name) => `.group-header:has-text('Local') ~ .branch:has(.branch-name:text-is('${name}')) >> nth=0`;
const selected = () => page.$$eval(".sidebar .branch.selected .branch-name", (els) => [...new Set(els.map((e) => e.textContent))].sort().join(","));

await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".sidebar .branch", { timeout: 30000 });
await page.click(".group-header:has-text('Tags')");

// Ctrl+click adds one branch, Shift+click a range, and a plain click selects one again.
await page.click(local("old-1"));
await page.click(local("old-2"), { modifiers: ["Control"] });
check("Ctrl+click selects two branches", (await selected()) === "old-1,old-2");
await page.click(local("old-2"), { modifiers: ["Control"] });
check("Ctrl+click again removes one", (await selected()) === "old-1");
await page.click(local("main"));
check("a plain click selects one branch", (await selected()) === "main");

// The menu of the selection: show only these branches in the log.
await page.click(local("fix/readme"));
await page.click(local("main"), { modifiers: ["Control"] });
await page.click(local("fix/readme"), { button: "right" });
check("the menu is for the selection", ((await page.textContent(".menu")) ?? "").includes("2 selected"));
await page.click(".menu-item:has-text('Show Only These in the Log')");
await within("the log filter holds both branches", async () => (await page.$$eval(".sidebar .branch.filtered .branch-name", (els) => [...new Set(els.map((e) => e.textContent))].sort().join(","))) === "fix/readme,main");
await page.click(".filter-bar .filter-x");

// Delete: two merged branches, an unmerged branch and a tag.
await page.click(local("old-1"));
await page.click(local("wip"), { modifiers: ["Control"] });
await page.click(local("old-2"), { modifiers: ["Control"] });
await page.click(`.branch-tag:has(.branch-name:text-is('try-1'))`, { modifiers: ["Control"] });
check("Ctrl+click selects a tag too", (await selected()) === "old-1,old-2,try-1,wip");
await page.click(local("wip"), { button: "right" });
await shot("bm1-menu");
await page.click(".menu-item:has-text('Delete 4 Branches and Tags')");
await page.waitForSelector(".dialog:has-text('Delete 4 branches and tags')");
check("the question lists the refs", ((await page.textContent(".dialog .dialog-files")) ?? "").includes("branch wip") && ((await page.textContent(".dialog .dialog-files")) ?? "").includes("tag try-1"));
await page.click(".dialog-buttons button:has-text('Delete')");
await page.waitForSelector(".dialog:has-text('not merged')");
check("the second question names the unmerged branch", ((await page.textContent(".dialog")) ?? "").includes("wip has commits that are not merged"));
check("the merged branches and the tag are gone", !has("refs/heads/old-1") && !has("refs/heads/old-2") && !has("refs/tags/try-1") && has("refs/heads/wip"));
await shot("bm2-not-merged");
await page.click(".dialog-buttons button:has-text('Delete Anyway')");
await within("the unmerged branch is gone too", async () => !has("refs/heads/wip"));
await within("the panel no longer shows them", async () => !(await page.$(local("wip"))) && !(await page.$(local("old-1"))));

// One Undo creates all four again.
await page.click(".toast button:has-text('Undo') >> nth=-1");
await within("Undo creates all of them again", async () => has("refs/heads/old-1") && has("refs/heads/old-2") && has("refs/heads/wip") && has("refs/tags/try-1"));
check("the tag is annotated again", git("cat-file", "-t", "refs/tags/try-1") === "tag");
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
