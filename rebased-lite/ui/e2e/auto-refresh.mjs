// UI scenario for auto refresh: changes made outside the app show up without Refresh.
// Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh, then:
// node e2e/auto-refresh.mjs <repo> <screenshot-dir>. The scenario changes the repository.
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
const [,, repo, outDir] = process.argv;
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).replace(/\s+$/, "");
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e));
page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));
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
await page.waitForTimeout(1500);

// A file edited in another program appears in the Changes tab.
appendFileSync(`${repo}/README.md`, "Edited outside\n");
await within("an edited file appears", async () => (await page.textContent(".commit-tree")).includes("README.md"));

// The diff of the shown file follows the file.
await page.click(".cl-file:has-text('main.rs')");
await page.waitForTimeout(1200);
const before = await page.textContent(".diff-stats");
appendFileSync(`${repo}/main.rs`, "fn more() {}\n");
await within("the shown diff follows the file", async () => (await page.textContent(".diff-stats")) !== before);

// A commit and a branch made in a terminal appear in the log and the branches.
git("add", "README.md");
git("commit", "-q", "-m", "Commit from a terminal", "--", "README.md");
await within("a commit from a terminal appears in the log", async () => (await page.textContent(".log-row >> nth=0")).includes("Commit from a terminal"));
git("branch", "made-in-terminal");
await page.click(".lp-tab:has-text('Branches')");
await within("a branch from a terminal appears", async () => (await page.textContent(".sidebar-list")).includes("made-in-terminal"));
await shot("ar1-refreshed");
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
