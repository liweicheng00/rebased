// UI scenario for stashes. Start the dev server first (see README).
// Build a fresh repository with make-demo-repo.sh, then: node e2e/stash.mjs <repo> <screenshot-dir>.
// The scenario changes the repository. Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
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

execFileSync("sh", ["-c", `cd "${repo}" && echo "More docs" >> README.md`]);
await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".log-row", { timeout: 30000 });
await page.click(".lp-tab:has-text('Changes')");
await page.waitForSelector(".cl-file");

// 1. Stash one file from the commit panel.
await page.click(".cl-file:has-text('main.rs')", { button: "right" });
await page.click(".menu-item:has-text('Stash Selected Files')");
await page.fill(".dialog-field:has-text('Message') input", "Helper function");
await page.click(".dialog-buttons button:has-text('Stash')");
await page.waitForTimeout(1500);
const status1 = git("status", "--porcelain");
check("main.rs is stashed, README.md stays", !status1.includes("main.rs") && status1.includes("README.md"));
await clearToasts();

// 2. Stash the rest with the unversioned file.
await page.click(".lp-tab:has-text('Stash')");
await page.click(".stash-all");
await page.fill(".dialog-field:has-text('Message') input", "Docs and notes");
await page.check(".dialog-check:has-text('unversioned') input");
await page.click(".dialog-buttons button:has-text('Stash')");
await page.waitForTimeout(1500);
check("working tree is clean", git("status", "--porcelain") === "");
check("two stashes listed", (await page.$$(".stash-row")).length === 2);
await clearToasts();

// 3. Select the stash: its files show, with the unversioned file.
await page.click(".stash-row:has-text('Docs and notes')");
await page.waitForTimeout(1500);
const files = (await page.textContent(".changes")).replace(/\s+/g, " ");
console.log("stash files:", files);
check("stash files include README.md and NOTES.txt", files.includes("README.md") && files.includes("NOTES.txt"));
await page.click(".change:has-text('NOTES.txt')");
await page.waitForTimeout(1000);
await shot("s1-stash-selected");

// 4. Pop the older stash; apply the newer one and keep it.
await page.click(".stash-row:has-text('Helper function')", { button: "right" });
await shot("s2-stash-menu");
await page.click(".menu-item:has(.menu-label:text-is('Pop'))");
await page.waitForTimeout(1500);
check("main.rs is back", git("status", "--porcelain").includes("main.rs"));
check("one stash left", (await page.$$(".stash-row")).length === 1);
await clearToasts();
await page.click(".stash-row:has-text('Docs and notes')", { button: "right" });
await page.click(".menu-item:has(.menu-label:text-is('Apply'))");
await page.waitForTimeout(1500);
check("README.md and NOTES.txt are back", git("status", "--porcelain").includes("README.md") && git("status", "--porcelain").includes("NOTES.txt"));
check("the applied stash stays", (await page.$$(".stash-row")).length === 1);
await clearToasts();

// 5. Drop it.
await page.click(".stash-row:has-text('Docs and notes')", { button: "right" });
await page.click(".menu-item:has-text('Drop')");
await page.click(".dialog-buttons button:has-text('Drop')");
await page.waitForTimeout(1500);
check("no stashes", git("stash", "list") === "");
await shot("s3-empty");
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
