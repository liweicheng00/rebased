// UI scenario for the commit message: commit.template, the message checks, and comment lines.
// Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh, then:
// node e2e/commit-message.mjs <repo> <screenshot-dir>. The scenario changes the repository.
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const [,, repo, outDir] = process.argv;
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).replace(/\s+$/, "");
git("config", "commit.gpgsign", "false");
const template = "Subject\n\n# Why is this change needed?\n";
writeFileSync(`${repo}/.git/rebased-template.txt`, template);
git("config", "commit.template", ".git/rebased-template.txt");

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
const warnings = () => page.$$eval(".commit-warnings:not([hidden]) > div", (e) => e.map((x) => x.textContent));

await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".log-row", { timeout: 30000 });
await page.click(".lp-tab:has-text('Commit')");
await page.waitForSelector(".cl-file:has-text('main.rs')");
await within("the empty message gets the template", async () => (await page.inputValue(".commit-message")) === template);

// The template alone is refused with a question.
await page.click(".cl-header:has-text('Changes') .cl-check");
if (!(await page.isChecked(".cl-header:has-text('Changes') .cl-check"))) await page.click(".cl-header:has-text('Changes') .cl-check");
await page.click(".commit-message");
await page.keyboard.press("Control+Enter");
await within("the template alone asks first", async () => ((await page.textContent(".dialog").catch(() => "")) ?? "").includes("commit template"));
await page.click(".dialog-buttons button:has-text('Cancel')");

// A long subject without a blank line gets two warnings.
await page.fill(".commit-message", "A".repeat(80) + "\nBody right after the subject");
await within("two warnings show", async () => (await warnings()).length === 2);
console.log("warnings:", (await warnings()).join(" | "));
await shot("cm1-warnings");

// A good message: no warnings, and the comment lines go away in the commit.
await page.fill(".commit-message", "Make the helper public\n\n# a comment line\nIt is used by the CLI now.");
await within("no warnings", async () => (await warnings()).length === 0);
await page.keyboard.press("Control+Enter");
await within("the commit is made", async () => git("log", "-1", "--format=%s") === "Make the helper public");
check("comment lines are removed", git("log", "-1", "--format=%B") === "Make the helper public\n\nIt is used by the CLI now.");
await within("the message field has the template again", async () => (await page.inputValue(".commit-message")) === template);
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
