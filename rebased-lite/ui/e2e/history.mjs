// UI scenario for file history and annotate. Start the dev server first (see README).
// Build a fresh repository with make-demo-repo.sh, then: node e2e/history.mjs <repo> <screenshot-dir>.
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
const [,, repo, outDir] = process.argv;
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e));
page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));
const shot = async (name) => { await page.waitForTimeout(800); await page.screenshot({ path: `${outDir}/${name}.png` }); console.log("shot", name); };
const check = (what, ok) => { console.log(ok ? "ok  " : "FAIL", what); if (!ok) errors.push("check: " + what); };

await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".log-row", { timeout: 30000 });

// History of arith.rs follows the rename from math.rs.
await page.click(".log-row:has-text('Rename math to arith')");
await page.waitForSelector(".change:has-text('arith.rs')");
await page.click(".change:has-text('arith.rs')", { button: "right" });
await page.click(".menu-item:has-text('Show History')");
await page.waitForSelector(".history-row");
const rows = await page.$$eval(".history-row .rebase-subject", (e) => e.map((x) => x.textContent));
console.log("history:", rows);
check("history follows the rename", rows.join("|") === "Rename math to arith and use wrapping add|Add math module");

// Annotate in the history window.
await page.check(".history-window .diff-option:has-text('Annotate') input");
await page.waitForSelector(".history-window .blame-first");
const labels = await page.$$eval(".history-window .blame-first", (e) => e.map((x) => x.textContent));
console.log("labels:", labels);
check("annotations name the author", labels.some((l) => l.includes("Ada Lovelace")));
await shot("h1-history-annotate");
await page.click(".history-row:has-text('Add math module')");
await page.waitForTimeout(1000);
check("the older commit shows the added file", (await page.textContent(".history-window .diff-stats")).includes("new file"));
await page.click(".history-window button:has-text('Show in Log')");
await page.waitForTimeout(1200);
check("the log selects the commit", (await page.textContent(".log-row.selected")).includes("Add math module"));

// Annotate a local change: an uncommitted line, then click an annotation to go to its commit.
await page.click(".lp-tab:has-text('Changes')");
await page.waitForSelector(".cl-file:has-text('main.rs')");
await page.click(".cl-file:has-text('main.rs')");
await page.waitForTimeout(1000);
await page.check(".workspace .diff-option:has-text('Annotate') input");
await page.waitForSelector(".workspace .blame-first");
const local = await page.$$eval(".workspace .blame-first", (e) => e.map((x) => x.textContent));
console.log("local labels:", local);
check("uncommitted line", local.some((l) => l.includes("not committed")));
await shot("h2-annotate-local");
await page.click(".workspace .blame-first >> nth=0");
await page.waitForTimeout(1200);
const sel = await page.textContent(".log-row.selected");
console.log("selected:", sel);
check("clicking an annotation selects its commit", sel.includes("Initial commit"));
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
