// UI scenario. Start the dev server first (see README), then: node e2e/demo-repo.mjs <repo> <screenshot-dir>
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
const [,, repo, outDir] = process.argv;
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e));
page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));
const shot = async (name) => { await page.waitForTimeout(900); await page.screenshot({ path: `${outDir}/${name}.png` }); console.log("shot", name); };
await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".changes .change", { timeout: 30000 });
await shot("d1-main");
console.log("sidebar:", (await page.textContent(".sidebar-list")).replace(/\s+/g, " "));
// working tree compare via context menu on HEAD row
await page.click(".log-row.selected", { button: "right" });
await page.click(".menu-item:has-text('Compare with Working Tree')");
await page.waitForTimeout(1500);
await shot("d2-worktree");
console.log("wt:", await page.textContent(".changes-title"), await page.textContent(".changes"));
// rename commit
await page.click(".log-row:has-text('Rename math to arith')");
await page.waitForTimeout(1500);
await shot("d3-rename");
console.log("rename:", await page.textContent(".diff-title"));
// binary
await page.click(".log-row:has-text('Add a binary logo')");
await page.waitForTimeout(1500);
console.log("binary:", await page.textContent(".diff-notice"));
// merge commit with collapse unchanged
await page.click(".log-row:has-text(\"Merge branch 'feature/parser'\")");
await page.check(".diff-option:has-text('Collapse unchanged') input");
await page.waitForTimeout(1500);
await shot("d4-merge-collapsed");
await page.uncheck(".diff-option:has-text('Collapse unchanged') input");
// two commits across branches
await page.click(".log-row:has-text('Print arguments')");
await page.click(".log-row:has-text('Greet the world')", { modifiers: ["Control"] });
await page.waitForTimeout(1500);
await shot("d5-two");
console.log("two:", await page.textContent(".changes-title"), await page.textContent(".changes-count"));
// sidebar compare with current
await page.click(".branch:has-text('parser')", { button: "right" });
await shot("d6-branch-menu");
await page.click(".menu-item:has-text('Compare with')");
await page.waitForTimeout(1500);
console.log("branch compare:", await page.textContent(".changes-title"));
// path filter
await page.fill(".filter-path", "parser.rs");
await page.waitForTimeout(2000);
await shot("d7-path-filter");
console.log("path filter:", await page.textContent(".filter-info"));
console.log("errors:", JSON.stringify(errors));
if (errors.length) process.exitCode = 1;
await browser.close();
