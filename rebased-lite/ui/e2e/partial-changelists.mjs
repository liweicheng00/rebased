// UI scenario for partial changelists: the changes of one file in two changelists, and a commit of
// one changelist that takes only its changes.
// Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh, then:
// node e2e/partial-changelists.mjs <repo> <screenshot-dir>. The scenario changes the repository.
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const [,, repo, outDir] = process.argv;
const git = (...args) => execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).replace(/\s+$/, "");

// A file with twenty lines, then two changes far apart.
const base = Array.from({ length: 20 }, (_, i) => `line ${i + 1}\n`).join("");
writeFileSync(`${repo}/list.txt`, base);
git("add", "list.txt");
git("commit", "-q", "-m", "Add a list");
const edited = base.replace("line 2\n", "line 2 fixed\n").replace("line 18\n", "line 18 debug\n");
writeFileSync(`${repo}/list.txt`, edited);

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e));
page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));
const shot = async (name) => { await page.waitForTimeout(500); await page.screenshot({ path: `${outDir}/${name}.png` }); console.log("shot", name); };
const check = (what, ok) => { console.log(ok ? "ok  " : "FAIL", what); if (!ok) errors.push("check: " + what); };
const within = async (what, fn, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return check(what, true);
    await page.waitForTimeout(200);
  }
  check(what, false);
};

await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".log-row", { timeout: 30000 });
await page.click(".lp-tab:has-text('Commit')");
await page.waitForSelector(".cl-file:has-text('list.txt')");

// A second changelist.
await page.click(".commit-toolbar .icon-button[title='New changelist']");
await page.fill(".dialog input >> nth=0", "Debug");
await page.click(".dialog-buttons button:has-text('Create')");
await page.waitForSelector(".cl-header:has-text('Debug')");

// Move the change at line 18 to Debug from the context menu of the diff.
await page.click(".cl-file:has-text('list.txt')");
await page.waitForSelector(".editor.modified .view-line:has-text('line 18 debug')");
await page.waitForTimeout(800);
await page.click(".editor.modified .view-line:has-text('line 18 debug')", { button: "right" });
await page.waitForTimeout(300);
await page.click(".action-label:has-text('Move Change to Another Changelist')");
await page.click(".menu-item:has-text('Debug')");
await within("list.txt is in both changelists", async () => (await page.$$(".cl-file:has-text('list.txt')")).length === 2);
const badges = await page.$$eval(".cl-split", (b) => b.map((x) => x.textContent));
check("each row has one of two changes", badges.length === 2 && badges.every((b) => b === "1/2"));
await page.click(".cl-header:has-text('Changes') ~ .cl-file:has-text('list.txt') >> nth=0");
await within("the diff marks the Debug change", async () => (await page.$$(".editor.modified .hunk-other-list")).length > 0);
await shot("pcl1-split-file");

// Commit only the Changes changelist: line 2 goes in, line 18 stays local in Debug.
await page.click(".cl-header:has-text('Changes')", { button: "right" });
await page.click(".menu-item:has-text('Commit Only This Changelist')");
await page.fill(".commit-message", "Fix line 2");
await page.keyboard.press("Control+Enter");
await within("the commit is made", async () => git("log", "-1", "--format=%s") === "Fix line 2");
const committed = git("show", "HEAD:list.txt");
check("the commit has the Changes change", committed.includes("line 2 fixed"));
check("the commit does not have the Debug change", !committed.includes("debug"));
check("the working tree keeps both changes", readFileSync(`${repo}/list.txt`, "utf8") === edited);
await within("list.txt is in Debug only", async () => {
  const rows = await page.$$(".cl-file:has-text('list.txt')");
  return rows.length === 1 && (await page.$$(".cl-split")).length === 0;
});
await shot("pcl2-after-commit");
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
