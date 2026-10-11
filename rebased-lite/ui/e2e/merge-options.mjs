// UI scenario for the options of Merge and Update: a squash merge, a merge commit with --no-ff and a
// message, and Update with "Only a fast-forward" on a branch with commits of its own.
// Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh, then:
// node e2e/merge-options.mjs <repo> <screenshot-dir>.
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
const [,, repo, outDir] = process.argv;
const git = (...args) => execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
// main without local changes, with a commit of its own: it is ahead of and behind origin/main.
git("stash", "-q", "-u");
git("commit", "-q", "--allow-empty", "-m", "Main work");

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
const menu = async (label) => {
  await page.waitForTimeout(400);
  await page.click(`.menu-item:has-text("${label}")`);
};
const toasts = async () => ((await page.textContent(".toasts").catch(() => "")) ?? "").replace(/\s+/g, " ");
const openMerge = async (name) => {
  await page.click(`.sidebar .branch[data-ref='refs/heads/${name}'] >> nth=-1`, { button: "right" });
  await menu("Merge into main");
  await page.waitForSelector(".dialog:has-text('Merge feature/cli into main')");
};

await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".sidebar .branch", { timeout: 30000 });

// Squash: the changes of feature/cli become local changes; HEAD stays.
const head = git("rev-parse", "HEAD");
await openMerge("feature/cli");
await page.selectOption(".dialog select", "squash");
await shot("mo1-merge-dialog");
await page.click(".dialog-buttons button:has-text('Merge')");
await within("the squash merge leaves local changes", async () => git("status", "--porcelain").includes("cli.rs") && git("rev-parse", "HEAD") === head);
check("the message says to commit", (await toasts()).includes("Commit them to finish the squash merge"));
git("reset", "-q", "--hard");

// --no-ff with a message: a merge commit with that message.
await page.waitForTimeout(2000);
await openMerge("feature/cli");
await page.selectOption(".dialog select", "noFf");
await page.fill(".dialog-field:has-text('Message') input", "Merge the CLI");
await page.click(".dialog-buttons button:has-text('Merge')");
await within("a merge commit with the message", async () => git("log", "-1", "--format=%s") === "Merge the CLI" && git("log", "-1", "--format=%p").split(" ").length === 2);

// Update with Only a fast-forward: main has commits of its own, so nothing changes.
await page.waitForTimeout(2000);
const before = git("rev-parse", "HEAD");
await page.click(".tb-button:has-text('Update')");
await page.waitForSelector(".dialog:has-text('Update main')");
await page.check(".dialog input[value='merge']");
await page.selectOption(".dialog .update-ff", "ffOnly");
await shot("mo2-update-dialog");
await page.click(".dialog-buttons button:has-text('Update')");
await within("Update says that it cannot fast-forward", async () => (await toasts()).includes("cannot fast-forward"));
check("main stays", git("rev-parse", "HEAD") === before);
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
