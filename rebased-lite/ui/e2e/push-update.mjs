// UI scenario for Push, Update and Commit and Push. Start the dev server first (see README).
// Build a fresh repository with make-demo-repo.sh, then: node e2e/push-update.mjs <repo> <screenshot-dir>.
// The scenario changes the repository and its "-origin" repository.
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
const [,, repo, outDir] = process.argv;
const origin = repo + "-origin";
const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).replace(/\s+$/, "");
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e));
page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));
const shot = async (name) => { await page.waitForTimeout(700); await page.screenshot({ path: `${outDir}/${name}.png` }); console.log("shot", name); };
const check = (what, ok) => { console.log(ok ? "ok  " : "FAIL", what); if (!ok) errors.push("check: " + what); };
const toastText = async () => (await page.textContent(".toasts").catch(() => "")).replace(/\s+/g, " ");
const clearToasts = () => page.evaluate(() => document.querySelectorAll(".toast").forEach((t) => t.remove()));
const switchTo = async (name) => {
  await page.click(".tb-branch-button");
  await page.click(`.switcher .menu-item:has(.menu-label:text-is('${name}'))`);
  await page.waitForTimeout(1200);
  await clearToasts();
};

// A local branch that is not on the remote yet.
git(repo, "branch", "topic/push-me", "main");
await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".sidebar .branch", { timeout: 30000 });

// 1. Push the branch that is one commit ahead.
await switchTo("feature/cli");
await page.click(".tb-button:has-text('Push')");
await page.waitForSelector(".push-commits");
check("push dialog lists the outgoing commit", (await page.textContent(".push-commits")).includes("Print arguments one per line"));
await shot("p1-push-dialog");
await page.click(".dialog-buttons button:has-text('Push')");
await page.waitForTimeout(1500);
console.log("push:", await toastText());
check("remote has the commit", git(origin, "rev-parse", "feature/cli") === git(repo, "rev-parse", "feature/cli"));
await clearToasts();

// 2. Push a new branch from the branch menu; it becomes tracked.
await page.click(".branch:has(.branch-name:text-is('topic/push-me'))", { button: "right" });
await page.click(".menu-item:has-text('Push…')");
await page.waitForSelector(".push-new:not([hidden])");
await shot("p2-push-new-branch");
await page.click(".dialog-buttons button:has-text('Push')");
await page.waitForTimeout(1500);
check("new branch is on the remote and tracked", git(repo, "config", "branch.topic/push-me.merge") === "refs/heads/topic/push-me");
await clearToasts();

// 3. Update main (one commit behind) with rebase; the local changes stay.
await switchTo("main");
await page.click(".tb-button:has-text('Update')");
await page.waitForSelector(".dialog-radios");
await page.check("input[value=rebase]");
await shot("p3-update-dialog");
await page.click(".dialog-buttons button:has-text('Update')");
await page.waitForTimeout(2000);
console.log("update:", await toastText());
check("main equals origin/main", git(repo, "rev-parse", "main") === git(repo, "rev-parse", "origin/main"));
check("local changes kept", git(repo, "status", "--porcelain").includes("main.rs"));
await clearToasts();

// 4. The remote moves on: the push is rejected, Update from the toast, then push again.
git(origin, "checkout", "-q", "feature/cli");
execFileSync("sh", ["-c", `sed -i '1i // remote header' "${origin}/cli.rs" && git -C "${origin}" commit -qam "Remote change on cli"`]);
git(origin, "checkout", "-q", "main");
await switchTo("feature/cli");
await page.click(".lp-tab:has-text('Commit')");
execFileSync("sh", ["-c", `echo "// more" >> "${repo}/cli.rs"`]);
await page.click("button[title='Refresh the local changes']");
await page.waitForSelector(".cl-file:has-text('cli.rs')");
await page.click(".cl-header:has-text('Changes') .cl-check");
await page.click(".cl-header:has-text('Changes') .cl-check");
await page.click(".cl-file:has-text('main.rs') .cl-check");
await page.fill(".commit-message", "Comment the CLI");
await page.click(".commit-push");
await page.waitForSelector(".push-commits");
await shot("p4-commit-and-push");
await page.click(".dialog-buttons button:has-text('Push')");
await page.waitForTimeout(1500);
console.log("rejected:", await toastText());
check("push rejected with an Update action", (await toastText()).includes("rejected") && !!(await page.$(".toast-action:has-text('Update')")));
await shot("p5-rejected");
await page.click(".toast-action:has-text('Update')");
await page.check("input[value=merge]");
await page.click(".dialog-buttons button:has-text('Update')");
await page.waitForSelector(".push-commits", { timeout: 15000 });
await page.click(".dialog-buttons button:has-text('Push')");
await page.waitForTimeout(1500);
check("remote has the merge", git(origin, "rev-parse", "feature/cli") === git(repo, "rev-parse", "feature/cli"));
check("the merge joins the local commit and the remote commit", git(repo, "log", "-1", "--format=%s", "HEAD^1") === "Comment the CLI" && git(repo, "log", "-1", "--format=%s", "HEAD^2") === "Remote change on cli");
check("main.rs is still a local change", git(repo, "status", "--porcelain").includes(" M main.rs"));
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
