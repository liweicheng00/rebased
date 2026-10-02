// UI scenario for Local History and Undo: the app keeps versions of changed files, a rolled-back change
// comes back from Local History, and Ctrl+Z undoes the last operation.
// Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh, then:
// node e2e/local-history.mjs <repo> <screenshot-dir>. The scenario changes the repository.
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
const [,, repo, outDir] = process.argv;
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).replace(/\s+$/, "");
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e));
page.on("console", (m) => { if (process.env.LOGALL) console.log("console:", m.type(), m.text()); if (m.type() === "error") errors.push("console: " + m.text()); });
const shot = async (name) => { await page.waitForTimeout(500); await page.screenshot({ path: `${outDir}/${name}.png` }); console.log("shot", name); };
const check = (what, ok) => { console.log(ok ? "ok  " : "FAIL", what); if (!ok) errors.push("check: " + what); };
const within = async (what, fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return check(what, true);
    await page.waitForTimeout(200);
  }
  check(what, false);
};

await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".log-row", { timeout: 30000 });
await page.click(".lp-tab:has-text('Changes')");
await page.waitForSelector(".cl-file:has-text('main.rs')");
await page.waitForTimeout(1000);

// Two saves in another program: each one is a version.
appendFileSync(`${repo}/main.rs`, "// first edit\n");
await page.waitForTimeout(1200);
appendFileSync(`${repo}/main.rs`, "// second edit\n");
await page.waitForTimeout(1200);
const edited = readFileSync(`${repo}/main.rs`, "utf8");

// Rollback loses the edits.
await page.click(".cl-file:has-text('main.rs')", { button: "right" });
await page.click(".menu-item:has-text('Rollback')");
await page.click(".dialog-buttons button:has-text('Rollback')");
await within("main.rs is rolled back", async () => !git("status", "--porcelain").includes("main.rs"));

// The versions and the rolled-back content are in Local History.
await page.click(".tb-button:has-text('Local History')");
await page.waitForSelector(".local-history-row");
const rows = await page.$$eval(".local-history-row", (r) => r.map((x) => x.textContent));
console.log("versions:", rows.join(" | "));
check("the edits are versions", rows.filter((r) => r.includes("Changed") && r.includes("main.rs")).length >= 2);
check("a version before the rollback", rows.some((r) => r.includes("Before Rollback")));
await page.click(".local-history-row:has-text('Before Rollback')");
await page.waitForTimeout(1200);
await shot("lh1-local-history");

// Revert brings the edits back.
await page.click(".history-window .tb-button:has-text('Revert')");
await page.click(".dialog-buttons button:has-text('Revert')");
await within("the edits come back", async () => readFileSync(`${repo}/main.rs`, "utf8") === edited);
await page.click(".history-window .tb-button:has-text('Close')");
await within("main.rs is a local change again", async () => (await page.textContent(".commit-tree")).includes("main.rs"));

// Ctrl+Z undoes the last operation: here a commit.
const head = git("rev-parse", "HEAD");
await page.click(".cl-header:has-text('Changes') .cl-check");
await page.fill(".commit-message", "Keep the edits");
await page.keyboard.press("Control+Enter");
await within("the commit is made", async () => git("rev-parse", "HEAD") !== head);
// The operation ends with its notification; only then is its undo known.
await page.waitForSelector(".toast-action:has-text('Undo')");
await page.click(".log-row >> nth=1");
await page.keyboard.press("Control+z");
await within("Ctrl+Z undoes the commit", async () => git("rev-parse", "HEAD") === head);
check("the edits stay as local changes", git("status", "--porcelain").includes("main.rs"));
await shot("lh2-undo");
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
