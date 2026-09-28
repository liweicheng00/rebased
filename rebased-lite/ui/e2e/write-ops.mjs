// UI scenario for the write operations, the branch switcher, worktrees and the dark theme.
// Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh, because
// the scenario changes it. Then: node e2e/write-ops.mjs <repo> <screenshot-dir>
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
const [,, repo, outDir] = process.argv;
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e));
page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));
const shot = async (name) => { await page.waitForTimeout(800); await page.screenshot({ path: `${outDir}/${name}.png` }); console.log("shot", name); };
const toastText = async () => (await page.textContent(".toasts").catch(() => "")).replace(/\s+/g, " ");
const clearToasts = () => page.evaluate(() => document.querySelectorAll(".toast").forEach((t) => t.remove()));
const branchBtn = async () => (await page.textContent(".tb-branch-button")).trim();
await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".log-row", { timeout: 30000 }); await page.waitForSelector(".sidebar .branch");
await page.waitForTimeout(1200);
console.log("branch:", await branchBtn());
console.log("sidebar:", (await page.textContent(".sidebar-list")).replace(/\s+/g, " "));
await shot("v1-main");

// branch switcher with recent branches
await page.click(".tb-branch-button");
await shot("v2-switcher");
console.log("switcher:", (await page.textContent(".switcher-list")).replace(/\s+/g, " ").slice(0, 300));
await page.click(".switcher .menu-item:has-text('feature/cli')");
await page.waitForTimeout(1500);
console.log("after checkout:", await branchBtn(), "|", await toastText());
await clearToasts();

// squash two commits
await page.click(".log-row:has-text('Print arguments')");
await page.click(".log-row:has-text('Add a CLI entry point')", { modifiers: ["Control"] });
await page.click(".log-row:has-text('Print arguments')", { button: "right" });
await shot("v3-commit-menu");
await page.click(".menu-item:has-text('Squash 2 Commits')");
await page.waitForSelector(".dialog");
await shot("v4a-published-warning");
await page.click(".dialog-buttons button:has-text('Continue')");
await page.waitForSelector(".dialog textarea");
await shot("v4-squash-dialog");
await page.click(".dialog-buttons button:has-text('Squash')");
await page.waitForTimeout(1500);
console.log("squash:", await toastText());
await shot("v5-squashed");
await page.click(".toast-action:has-text('Undo')");
await page.waitForTimeout(1500);
console.log("undo:", await toastText());
console.log("rows after undo:", (await page.$$eval(".log-row .subject-text", (e) => e.slice(0, 4).map((x) => x.textContent))).join(" | "));
await clearToasts();

// interactive rebase dialog
await page.click(".log-row:has-text('Add a CLI entry point')", { button: "right" });
await page.click(".menu-item:has-text('Interactively Rebase from Here')");
await page.click(".dialog-buttons button:has-text('Continue')").catch(() => {});
await page.waitForSelector(".rebase-list");
await page.selectOption(".rebase-row >> nth=1 >> .rebase-action", "squash");
await shot("v6-interactive-rebase");
await page.click(".dialog-buttons button:has-text('Cancel')");

// reset dialog
await page.click(".log-row:has-text('Add a CLI entry point')", { button: "right" });
await page.click(".menu-item:has-text('Reset feature/cli to Here')");
await page.waitForSelector(".dialog-radios");
await shot("v7-reset-dialog");
await page.click(".dialog-buttons button:has-text('Cancel')");

// merge conflict: topic/readme <- origin/main
await page.dblclick(".branch:has-text('topic/readme')");
await page.waitForTimeout(1500);
console.log("checkout topic:", await branchBtn());
await clearToasts();
await page.click(".branch:has-text('origin/main'), .branch:has(.branch-name:text-is('main'))  >> nth=-1", { button: "right" });
await page.click(".menu-item:has-text('Merge into topic/readme')");
await page.waitForTimeout(2000);
console.log("merge:", await toastText());
console.log("banner:", (await page.textContent(".op-banner")).replace(/\s+/g, " "));
await shot("v8-conflict-banner");
await clearToasts();
await page.click(".op-banner button:has-text('Abort')");
await page.click(".dialog-buttons button:has-text('Abort')");
await page.waitForTimeout(1500);
console.log("abort:", await toastText(), "banner hidden:", await page.$eval(".op-banner", (e) => e.hidden));
await clearToasts();

// worktree
await page.click(".group-action[title='Add a worktree']");
await page.waitForSelector(".dialog-field");
await page.fill(".dialog-field:has-text('Branch') input", "wt/experiment");
await page.fill(".dialog-field:has-text('Folder') input", repo + "-wt");
await shot("v9-worktree-dialog");
await page.click(".dialog-buttons button:has-text('Create')");
await page.waitForTimeout(1500);
console.log("worktree:", await toastText());
console.log("worktrees:", (await page.textContent(".sidebar-list")).replace(/\s+/g, " ").match(/Worktrees.*/)?.[0]);
await clearToasts();
await page.click(".branch.worktree:has-text('wt/experiment')", { button: "right" });
await shot("v10-worktree-menu");
await page.keyboard.press("Escape");

// back to main to show recent
await page.click(".tb-branch-button");
await page.click(".switcher .menu-item:has-text('main') >> nth=0");
await page.waitForTimeout(1500);
await clearToasts();
await page.click(".tb-branch-button");
console.log("recent:", (await page.textContent(".switcher-list")).replace(/\s+/g, " ").slice(0, 200));
await shot("v11-recent");
await page.keyboard.press("Escape");

// dark mode
await page.click(".tb-button[title='Theme']");
await page.click(".menu-item:has-text('Dark')");
await page.waitForTimeout(500);
console.log("theme:", await page.evaluate(() => document.documentElement.dataset.theme));
await page.click(".log-row:has-text('Rename math')");
await page.waitForTimeout(1500);
await shot("v12-dark");
await page.click(".log-row:has-text('Rename math')", { button: "right" });
await page.click(".menu-item:has-text('Reset main to Here')");
await shot("v13-dark-dialog");
await page.click(".dialog-buttons button:has-text('Cancel')");
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
