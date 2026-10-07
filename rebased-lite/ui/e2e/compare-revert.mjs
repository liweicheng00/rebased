// UI scenario for Revert in a compare with the working tree: the revert button of one change, Revert This
// Change in the menu of the diff, Revert to <branch> for a whole file in the Compare window, and Revert
// This Change in the diff of the Changes tab. It also checks the titles of the commits of the window.
// Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh, then:
// node e2e/compare-revert.mjs <repo> <screenshot-dir>.
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const [,, repo, outDir] = process.argv;
const read = (f) => readFileSync(`${repo}/${f}`, "utf8");
const original = read("parser.rs");
// Two changes in parser.rs: a line at the top and a line at the end.
writeFileSync(`${repo}/parser.rs`, `// top\n${original}// bottom\n`);
const mainAtHead = execFileSync("git", ["-C", repo, "show", "HEAD:main.rs"], { encoding: "utf8" });
// A long file in HEAD, with a change near the top and one near the end in the working tree.
const longLines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`);
writeFileSync(`${repo}/long.txt`, longLines.join("\n") + "\n");
execFileSync("git", ["-C", repo, "add", "long.txt"]);
execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "Long file"]);
const longAtHead = read("long.txt");
writeFileSync(`${repo}/long.txt`, longAtHead.replace("line 5\n", "LINE 5\n").replace("line 280\n", "LINE 280\n"));

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e));
const shot = async (name) => { await page.waitForTimeout(500); await page.screenshot({ path: `${outDir}/${name}.png` }); console.log("shot", name); };
const check = (what, ok) => { console.log(ok ? "ok  " : "FAIL", what); if (!ok) errors.push("check: " + what); };
const within = async (what, fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return check(what, true);
    await page.waitForTimeout(200);
  }
  check(what, false);
};
const win = ".merge-overlay";
const glyphs = () => page.$$(`${win} .revert-glyph`);
// The menu of Monaco ignores a click that comes right after it opens, so the click waits a moment.
const menuItem = async (label) => {
  const item = page.locator(".monaco-menu .action-label", { hasText: label });
  await item.waitFor();
  await page.waitForTimeout(400);
  return item;
};

await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".log-row", { timeout: 30000 });
await page.keyboard.press("Control+2");
await page.dblclick(".cl-file:has(.path:text-is('parser.rs'))");
await page.waitForSelector(`${win} .compare-file`);
await within("each change has a revert button", async () => (await glyphs()).length === 2);
check("the buttons are in the middle: in the gutter of the right side", (await page.$$(`${win} .editor.modified .revert-glyph`)).length === 2);
check("the commits part says that the working tree is on main", ((await page.textContent(`${win} .compare-commits`)) ?? "").includes("The working tree is on main, at the same commit as main"));
await shot("cr1-compare");

// The button of the first change.
await page.click(`${win} .revert-glyph >> nth=0`);
await within("the button reverts only the first change", async () => read("parser.rs") === `${original}// bottom\n`);
await within("the diff shows one change now", async () => (await glyphs()).length === 1);

// Revert This Change in the menu of the diff.
await page.click(`${win} .editor.modified .view-line:has-text('// bottom')`, { button: "right" });
await (await menuItem("Revert This Change")).click();
await within("the menu reverts the other change", async () => read("parser.rs") === original);
await within("parser.rs leaves the list", async () => !(((await page.textContent(`${win} .compare-files`)) ?? "").includes("parser.rs")));

// A revert does not load the window again: the diff keeps its scroll position, and the commits stay.
await page.click(`${win} .compare-file:has-text('long.txt')`);
await page.waitForSelector(`${win} .editor.modified .view-line:has-text('LINE 5')`);
await page.$eval(`${win} .compare-commits`, (e) => e.setAttribute("data-mark", "kept"));
// Go to the second change, near the end of the file.
await page.click(`${win} .diff-toolbar button[title^='Next change']`);
await page.waitForTimeout(600);
if (!(await page.$(`${win} .editor.modified .view-line:has-text('LINE 280')`))) await page.click(`${win} .diff-toolbar button[title^='Next change']`);
await page.waitForSelector(`${win} .editor.modified .view-line:has-text('LINE 280')`);
await page.waitForTimeout(600);
// Where the line before the change is on the screen.
const scrollTop = () => page.$$eval(`${win} .editor.modified .view-line`, (els) => Math.round(els.find((e) => /line\s279$/.test(e.textContent.trim()))?.getBoundingClientRect().top ?? -1));
const before = await scrollTop();
const line280 = await page.$$eval(`${win} .editor.modified .view-line`, (els) => els.findIndex((e) => /LINE\s280/.test(e.textContent)));
check("the second change shows", line280 >= 0);
const glyphAt280 = await page.evaluateHandle((w) => {
  const target = [...document.querySelectorAll(`${w} .editor.modified .view-line`)].find((e) => /LINE\s280/.test(e.textContent));
  const top = target.getBoundingClientRect().top;
  return [...document.querySelectorAll(`${w} .editor.modified .revert-glyph`)].find((g) => Math.abs(g.getBoundingClientRect().top - top) < 4);
}, win);
await glyphAt280.asElement().click();
await within("the change near the end is reverted", async () => !read("long.txt").includes("LINE 280") && read("long.txt").includes("LINE 5"));
await within("the diff shows one change", async () => ((await page.textContent(`${win} .diff-stats`)) ?? "").includes("1 change"));
check("the diff keeps its scroll position", (await scrollTop()) === before);
check("the commits part did not load again", (await page.getAttribute(`${win} .compare-commits`, "data-mark")) === "kept");
// The last change of the file: the file leaves the list, and the next file shows.
await page.click(`${win} .diff-toolbar button[title^='Previous change']`);
await page.waitForSelector(`${win} .editor.modified .view-line:has-text('LINE 5')`);
await page.waitForTimeout(400);
await page.click(`${win} .revert-glyph >> nth=0`);
await within("long.txt leaves the list", async () => !(((await page.textContent(`${win} .compare-files`)) ?? "").includes("long.txt")));
check("a file still shows in the diff", ((await page.textContent(`${win} .diff-title`)) ?? "").trim() !== "");

// A whole file: NOTES.txt is not on main, so Revert deletes it.
await page.click(`${win} .compare-file:has-text('NOTES.txt')`, { button: "right" });
await shot("cr2-file-menu");
await page.click(".menu-item:has-text('Revert to main')");
await page.click(".dialog-buttons button:has-text('Revert')");
await within("Revert to main deletes a file that main does not have", async () => !existsSync(`${repo}/NOTES.txt`));
await page.keyboard.press("Escape");
await page.waitForSelector(win, { state: "detached" });

// The diff of the Changes tab: the » and the commit check box are side by side in the middle.
const x = (sel) => page.$eval(sel, (e) => e.getBoundingClientRect().left);
await page.click(".cl-file:has(.path:text-is('main.rs'))");
await page.waitForSelector(".diff .editor.modified .view-line:has-text('fn helper')");
await within("the Changes diff has the button and the check box", async () =>
  (await page.$$(".diff .editor.modified .revert-glyph")).length === 1 && (await page.$$(".diff .editor.modified .hunk-on")).length === 1);
check("the button is left of the check box", (await x(".diff .editor.modified .revert-glyph")) < (await x(".diff .editor.modified .hunk-on")));
await shot("cr3-changes-diff");
// The check box still works.
await page.click(".diff .editor.modified .hunk-on");
await within("a click on the check box leaves the change out", async () => (await page.$$(".diff .editor.modified .hunk-off")).length === 1);
check("and reverts nothing", read("main.rs") !== mainAtHead);
// Revert This Change in the menu rolls back to HEAD.
await page.click(".diff .editor.modified .view-line:has-text('fn helper')", { button: "right" });
await (await menuItem("Revert This Change")).click();
await within("the Changes diff rolls back the change", async () => read("main.rs") === mainAtHead);

// One column: the button and the check box stay together; a click on the button reverts.
const arithAtHead = read("arith.rs");
writeFileSync(`${repo}/arith.rs`, arithAtHead + "// more\n");
await page.click(".diff-option:has-text('Side by side') input");
await page.click(".tb-button:has-text('Refresh')");
await page.click(".cl-file:has(.path:text-is('arith.rs'))");
await page.waitForSelector(".diff .editor.modified .view-line:has-text('// more')");
await within("in one column, the button and the check box show", async () =>
  (await page.$$(".diff .revert-glyph")).length === 1 && (await page.$$(".diff .hunk-on")).length === 1);
await page.click(".diff .revert-glyph");
await within("a click on the button reverts the change", async () => read("arith.rs") === arithAtHead);
await page.click(".diff-option:has-text('Side by side') input");
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
