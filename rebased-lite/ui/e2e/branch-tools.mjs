// UI scenario for the branch tools: Group Branches by Prefix, Update (Fast-Forward) of a branch that is not
// checked out, Checkout and Rebase onto Current, and protected branches.
// Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh, then:
// node e2e/branch-tools.mjs <repo> <screenshot-dir>.
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
const [,, repo, outDir] = process.argv;
const git = (...args) => execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
const origin = `${repo}-origin`;
const gitO = (...args) => execFileSync("git", ["-C", origin, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
// fix/readme gets a new commit upstream; the clone fetches it, so fix/readme is behind.
gitO("checkout", "-q", "fix/readme");
appendFileSync(`${origin}/README.md`, "More build notes\n");
gitO("commit", "-qam", "More build notes");
gitO("checkout", "-q", "main");
git("fetch", "-q");
// main gets a commit that topic/readme does not have.
git("commit", "-q", "--allow-empty", "-m", "Main moves on");

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
const branch = (name) => `.sidebar .branch[data-ref='refs/heads/${name}'] >> nth=-1`;
const toasts = async () => ((await page.textContent(".toasts").catch(() => "")) ?? "").replace(/\s+/g, " ");

await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".sidebar .branch", { timeout: 30000 });

// Group Branches by Prefix: folders for feature/, fix/ and topic/.
await page.click(".tb-button:has-text('View')");
await menu("Group Branches by Prefix");
await within("the Local group has folders", async () => (await page.$$eval(".sidebar .branch-folder .branch-name", (els) => els.map((e) => e.textContent))).join(",").includes("feature,fix,topic"));
check("a branch in a folder shows its last part", ((await page.textContent(branch("fix/readme"))) ?? "").includes("readme") && !((await page.textContent(branch("fix/readme"))) ?? "").includes("fix/"));
await shot("bt1-folders");
await page.click(".sidebar .branch-folder:has(.branch-name:text-is('topic')) >> nth=0");
await within("a click closes the folder", async () => (await page.$$(`.sidebar .branch[data-ref='refs/heads/topic/readme']`)).length === 1);
await page.click(".sidebar .branch-folder:has(.branch-name:text-is('topic')) >> nth=0");

// Update (Fast-Forward): fix/readme moves to its tracked branch; main stays checked out.
const before = git("rev-parse", "fix/readme");
await page.click(branch("fix/readme"), { button: "right" });
await menu("Update (Fast-Forward)");
await within("fix/readme is at origin/fix/readme", async () => git("rev-parse", "fix/readme") === git("rev-parse", "origin/fix/readme"));
check("main is still checked out", git("branch", "--show-current") === "main");
await page.click(".toast button:has-text('Undo') >> nth=-1");
await within("Undo moves fix/readme back", async () => git("rev-parse", "fix/readme") === before);

// Checkout and Rebase onto Current: topic/readme gets the commit of main and is checked out.
await page.click(branch("topic/readme"), { button: "right" });
await menu("Checkout and Rebase onto main");
await within("topic/readme is checked out and on top of main", async () => git("branch", "--show-current") === "topic/readme" && git("log", "--format=%s", "-2").endsWith("Main moves on"));
check("the local changes stay", git("status", "--porcelain").includes("main.rs"));
await page.click(".toast button:has-text('Undo') >> nth=-1");
await within("Undo checks out main again", async () => git("branch", "--show-current") === "main" && !git("log", "--format=%s", "-3", "topic/readme").includes("Main moves on"));

// Protected branches: a commit of origin/main is not rewritten.
await page.click(".log-row:has(.subject-text:text-is('Add a binary logo'))", { button: "right" });
await menu("Edit Commit Message");
await within("the reword stops on the protected branch", async () => (await toasts()).includes("protected branch origin/main"));
await shot("bt2-protected");
await page.click(".tb-button[title='Settings']");
await page.click(".settings-page:has-text('Git')");
check("the Git page has the protected branches", (await page.inputValue(".settings-row:has-text('Protected branches') input")) === "main master");
await page.click(".dialog-buttons button:has-text('Cancel')");
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
