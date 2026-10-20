// UI scenario for the compare window of the working tree: it loads again when files change outside the
// app. A double click on a local change opens it. The diff keeps its file, a new file shows in the list,
// and a commit made outside the app empties the list.
// Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh, then:
// node e2e/compare-refresh.mjs <repo> <screenshot-dir>.
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
const [,, repo, outDir] = process.argv;
const git = (...args) => execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();

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
const win = ".history-window[aria-label='Compare Branches']";
const files = () => page.$$eval(`${win} .compare-file`, (els) => els.map((e) => e.title).sort().join(","));
const selected = () => page.$eval(`${win} .compare-file.selected`, (e) => e.title).catch(() => "");
const diffText = async () => ((await page.textContent(`${win} .editor.modified .view-lines`).catch(() => "")) ?? "").replace(/\s/g, "");

await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".log-row", { timeout: 30000 });
await page.keyboard.press("Control+2");
await page.dblclick(".cl-file:has(.path:text-is('main.rs'))");
await page.waitForSelector(`${win} .compare-file.selected`);
await within("the window shows main.rs of the working tree", async () => (await selected()) === "main.rs" && (await diffText()).includes("fnhelper(){}"));
await page.$eval(win, (w) => (w.dataset.mark = "kept"));

// main.rs changes on disk: the diff shows the new line and stays on main.rs.
appendFileSync(`${repo}/main.rs`, "fn changed_outside() {}\n");
await within("the diff shows the change from outside", async () => (await diffText()).includes("fnchanged_outside(){}"));
check("the diff stays on main.rs", (await selected()) === "main.rs");

// A new file outside the app: git add makes it a change of the working tree, and the list shows it.
writeFileSync(`${repo}/added.rs`, "pub fn added() {}\n");
git("add", "added.rs");
await within("the new file shows in the list", async () => (await files()).includes("added.rs"));
check("the window is the same, not a new one", (await page.$(`${win}[data-mark='kept']`)) !== null);
await shot("cr1-refreshed");

// A commit outside the app of all changes: the working tree has no changes to the branch any more.
await page.waitForTimeout(2000);
git("add", "-A");
git("commit", "-q", "-m", "Commit outside the app");
await within("the list is empty after the commit", async () => (await files()) === "");
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
