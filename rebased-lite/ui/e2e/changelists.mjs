// UI scenario for changelists and the commit panel. Start the dev server first (see README).
// Build a fresh repository with make-demo-repo.sh, then add local changes:
//   echo "More docs" >> README.md; sed -i 's/wrapping_add/saturating_add/' arith.rs
//   echo 'pub fn sub() {}' > sub.rs; git add sub.rs
// Then: node e2e/changelists.mjs <repo> <screenshot-dir>. The scenario changes the repository.
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
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
const tree = async () => (await page.textContent(".commit-tree")).replace(/\s+/g, " ");
const toastText = async () => (await page.textContent(".toasts").catch(() => "")).replace(/\s+/g, " ");
const clearToasts = () => page.evaluate(() => document.querySelectorAll(".toast").forEach((t) => t.remove()));

await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".log-row", { timeout: 30000 });
await page.click(".lp-tab:has-text('Commit')");
await page.waitForSelector(".cl-file");
console.log("tree:", await tree());
check("tab shows the count", (await page.textContent(".lp-tab:has-text('Commit')")).includes("(5)"));
await page.click(".cl-file:has-text('arith.rs')");
await page.waitForTimeout(1200);
await shot("cl1-commit-panel");

// New changelist with README.md, from the file menu.
await page.click(".cl-file:has-text('README.md')", { button: "right" });
await page.click(".menu-item:has-text('New Changelist')");
await page.fill(".dialog-field:has-text('Name') input", "Docs");
await page.fill(".dialog-field:has-text('Comment') textarea", "Document the release");
await page.click(".dialog-buttons button:has-text('Create')");
await page.waitForSelector(".cl-header:has-text('Docs')");
// Move sub.rs with drag and drop.
await page.dragAndDrop(".cl-file:has-text('sub.rs')", ".cl-header:has-text('Docs')");
await page.waitForTimeout(800);
console.log("tree:", await tree());
check("Docs holds README.md and sub.rs", /Docs ?2 files.*README\.md.*sub\.rs/.test(await tree()));
await shot("cl2-two-changelists");

// Commit only the Docs changelist.
await page.click(".cl-header:has-text('Docs')", { button: "right" });
await shot("cl3-changelist-menu");
await page.click(".menu-item:has-text('Commit Only This Changelist')");
check("draft message loaded", (await page.inputValue(".commit-message")) === "Document the release");
check("commit button names the list", (await page.textContent(".commit-button")).includes("Docs"));
await shot("cl4-ready");
await page.click(".commit-button");
await page.waitForTimeout(2000);
console.log("toast:", await toastText());
const files = git("show", "--name-only", "--format=", "HEAD");
check("commit has only the Docs files", files === "README.md\nsub.rs");
check("commit message", git("log", "-1", "--format=%s") === "Document the release");
check("other files still modified", git("status", "--porcelain") === " M arith.rs\n M main.rs\n?? NOTES.txt");
console.log("status:", JSON.stringify(git("status", "--porcelain")), "tree:", await tree());
check("Docs list is empty and stays", /Docs ?0 files/.test(await tree()));
await shot("cl5-committed");

// Undo the commit: the changes come back as local changes.
await page.click(".toast-action:has-text('Undo')");
await page.waitForTimeout(1500);
check("undo restores the files", git("status", "--porcelain").includes("README.md") && git("log", "-1", "--format=%s") !== "Document the release");
await clearToasts();

// Amend loads the last message.
await page.check(".commit-amend input");
await page.waitForTimeout(500);
check("amend loads the HEAD message", (await page.inputValue(".commit-message")).length > 0);
await page.uncheck(".commit-amend input");

// Rollback of main.rs.
await page.click(".cl-file:has-text('main.rs')", { button: "right" });
await page.click(".menu-item:has-text('Rollback')");
await shot("cl6-rollback-dialog");
await page.click(".dialog-buttons button:has-text('Rollback')");
await page.waitForTimeout(1500);
check("main.rs rolled back", !git("status", "--porcelain").includes("main.rs"));
await clearToasts();

// Unversioned file: include it with the checkbox and commit with the default list.
await page.click(".cl-header:has-text('Changes') .cl-check");
await page.check(".cl-file:has-text('NOTES.txt') .cl-check");
await page.fill(".commit-message", "Add notes and arith change");
await page.keyboard.press("Control+Enter");
await page.waitForTimeout(2000);
check("commit with unversioned file", git("show", "--name-only", "--format=", "HEAD").includes("NOTES.txt"));

// Dark theme.
await page.click(".tb-button[title='Theme']");
await page.click(".menu-item:has-text('Dark')");
await page.click(".cl-header:has-text('Changes')");
await page.waitForTimeout(1200);
await shot("cl7-dark");
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
