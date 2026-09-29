// UI scenario for tabs: two repositories open at one time, each with its own log, filter and local
// changes, and the tabs come back after a reload.
// Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh, then:
// node e2e/tabs.mjs <repo> <screenshot-dir>. The scenario makes a second repository next to it.
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
const [,, repo, outDir] = process.argv;
const run = (dir, ...args) => execFileSync("git", ["-C", dir, "-c", "commit.gpgsign=false", "-c", "user.name=Tab", "-c", "user.email=tab@example.com", ...args], { encoding: "utf8" }).replace(/\s+$/, "");

// A second, small repository with one local change.
const second = `${repo}-second`;
rmSync(second, { recursive: true, force: true });
mkdirSync(second, { recursive: true });
run(second, "init", "-q", "-b", "trunk");
for (const n of ["First in second", "Second in second"]) {
  writeFileSync(`${second}/s.txt`, `${n}\n`);
  run(second, "add", ".");
  run(second, "commit", "-q", "-m", n);
}
writeFileSync(`${second}/s.txt`, "local\n");

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e));
page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));
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
const firstSubject = () => page.textContent(".log-row >> nth=0");

await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".log-row", { timeout: 30000 });
check("one repository has no tab bar", await page.$eval(".tabbar", (e) => e.hidden));

// Filter the first repository, then open the second one in a new tab.
await page.fill(".filter-bar input >> nth=0", "parser");
await page.keyboard.press("Enter");
await within("the filter applies", async () => (await page.$$(".log-row")).length < 6);
const filteredRows = (await page.$$(".log-row")).length;
await page.keyboard.press("Control+o");
await page.fill(".dialog-input", second);
await page.keyboard.press("Enter");
await within("the second repository shows", async () => (await firstSubject()).includes("Second in second"));
check("two tabs", (await page.$$(".tab")).length === 2);
check("the new tab is active", (await page.textContent(".tab.on")).includes("-second"));
await page.click(".lp-tab:has-text('Commit')");
await within("the local change of the second repository", async () => (await page.$(".cl-file:has-text('s.txt')")) !== null);
await shot("tab1-second-repo");

// Back to the first tab: its filter comes back.
await page.click(".tab:not(.on)");
await within("the first repository shows with its filter", async () => (await page.$$(".log-row")).length === filteredRows);
check("the filter text comes back", (await page.inputValue(".filter-bar input >> nth=0")) === "parser");
await within("the local changes of the first repository", async () => (await page.$(".cl-file:has-text('main.rs')")) !== null);

// Ctrl+PageDown goes to the next tab.
await page.click(".log-row >> nth=0");
await page.keyboard.press("Control+PageDown");
await within("Ctrl+PageDown shows the second repository", async () => (await firstSubject()).includes("Second in second"));

// A reload opens the same tabs, with the second one active.
await page.goto("http://127.0.0.1:5174/");
await within("the tabs come back", async () => (await page.$$(".tab")).length === 2);
await within("the active tab loads", async () => ((await firstSubject()) ?? "").includes("Second in second"), 15000);

// Close the second tab: the first one shows, and the tab bar hides.
await page.click(".tab.on .tab-close");
await within("the first repository shows after close", async () => ((await firstSubject()) ?? "").length > 0 && !(await firstSubject()).includes("in second"));
check("the tab bar hides with one tab", await page.$eval(".tabbar", (e) => e.hidden));
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
