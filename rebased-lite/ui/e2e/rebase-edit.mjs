// UI scenario for the Edit step of an interactive rebase: stop, change the commit, amend, continue.
// Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh, then:
// node e2e/rebase-edit.mjs <repo> <screenshot-dir>. The scenario changes the repository.
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
page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));
const shot = async (name) => { await page.waitForTimeout(700); await page.screenshot({ path: `${outDir}/${name}.png` }); console.log("shot", name); };
const check = (what, ok) => { console.log(ok ? "ok  " : "FAIL", what); if (!ok) errors.push("check: " + what); };
const clearToasts = () => page.evaluate(() => document.querySelectorAll(".toast").forEach((t) => t.remove()));

await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".sidebar .branch", { timeout: 30000 });
await page.click(".tb-branch-button");
await page.click(".switcher .menu-item:has(.menu-label:text-is('feature/cli'))");
await page.waitForTimeout(1200);
await clearToasts();

await page.click(".log-row:has-text('Add a CLI entry point')", { button: "right" });
await page.click(".menu-item:has-text('Interactively Rebase from Here')");
await page.click(".dialog-buttons button:has-text('Continue')").catch(() => {});
await page.waitForSelector(".rebase-list");
await page.selectOption(".rebase-row >> nth=0 >> .rebase-action", "edit");
await shot("re1-dialog");
await page.click(".dialog-buttons button:has-text('Start Rebasing')");
await page.waitForTimeout(2000);
const banner = (await page.textContent(".op-banner")).replace(/\s+/g, " ");
console.log("banner:", banner);
check("the rebase stops for editing", banner.includes("Rebase in progress") && banner.includes("for editing"));
check("git is in a rebase", git("status").includes("interactive rebase in progress"));
check("the toolbar names the branch", (await page.textContent(".tb-branch-button")).includes("rebasing feature/cli"));
await shot("re2-stopped");
await clearToasts();

// Change the commit: edit cli.rs and amend in the Changes tab.
appendFileSync(`${repo}/cli.rs`, "// edited during the rebase\n");
await page.click(".lp-tab:has-text('Changes')");
await page.click("button[title='Refresh the local changes']");
await page.waitForSelector(".cl-file:has-text('cli.rs')");
await page.check(".cl-file:has-text('cli.rs') .cl-check");
await page.check(".commit-amend input");
await page.waitForTimeout(500);
check("amend loads the message of the stopped commit", (await page.inputValue(".commit-message")).startsWith("Print arguments one per line"));
await page.click(".commit-button");
await page.waitForTimeout(1500);
await clearToasts();
await page.click(".op-banner button:has-text('Continue')");
await page.waitForTimeout(2000);
check("the rebase is done", !git("status").includes("rebase in progress"));
check("the commit has the edit", git("show", "HEAD:cli.rs").includes("// edited during the rebase"));
check("the subject stays", git("log", "-1", "--format=%s") === "Print arguments one per line");
check("the local change of main.rs came back", git("status", "--porcelain").includes(" M main.rs"));
await shot("re3-done");
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
