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
check("side by side, the buttons are on the left side, as in IntelliJ", (await page.$$(`${win} .editor.original .revert-glyph`)).length === 2);
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

// A whole file: NOTES.txt is not on main, so Revert deletes it.
await page.click(`${win} .compare-file:has-text('NOTES.txt')`, { button: "right" });
await shot("cr2-file-menu");
await page.click(".menu-item:has-text('Revert to main')");
await page.click(".dialog-buttons button:has-text('Revert')");
await within("Revert to main deletes a file that main does not have", async () => !existsSync(`${repo}/NOTES.txt`));
await page.keyboard.press("Escape");
await page.waitForSelector(win, { state: "detached" });

// The diff of the Changes tab: Revert This Change rolls back to HEAD.
await page.click(".cl-file:has(.path:text-is('main.rs'))");
await page.waitForSelector(".diff .editor.modified .view-line:has-text('fn helper')");
await within("the Changes diff has the button on the left side, and the check box on the right", async () =>
  (await page.$$(".diff .editor.original .revert-glyph")).length === 1 && (await page.$$(".diff .editor.modified .hunk-on")).length === 1);
await shot("cr3-changes-diff");
await page.click(".diff .editor.modified .view-line:has-text('fn helper')", { button: "right" });
await (await menuItem("Revert This Change")).click();
await within("the Changes diff rolls back the change", async () => read("main.rs") === mainAtHead);

// One column: the button moves to the right side.
writeFileSync(`${repo}/arith.rs`, read("arith.rs") + "// more\n");
await page.click(".diff-option:has-text('Side by side') input");
await page.click(".tb-button:has-text('Refresh')");
await page.click(".cl-file:has(.path:text-is('arith.rs'))");
await page.waitForSelector(".diff .editor.modified .view-line:has-text('// more')");
await within("in one column, the menu item is the way: the check boxes keep the right gutter", async () => (await page.$$(".diff .revert-glyph")).length === 0);
await page.click(".diff-option:has-text('Side by side') input");
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
