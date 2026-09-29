// UI scenario for a partial commit: uncheck one change of a file in the diff, commit the rest.
// Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh, then:
// node e2e/partial-commit.mjs <repo> <screenshot-dir>. The scenario changes the repository.
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const [,, repo, outDir] = process.argv;
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).replace(/\s+$/, "");

const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
writeFileSync(`${repo}/calc.txt`, lines.join("\n") + "\n");
git("add", "calc.txt");
git("commit", "-q", "-m", "Add calc.txt");
const changed = lines.map((l, i) => (i === 1 ? "line 2 changed" : i === 8 ? "line 9 changed" : l));
writeFileSync(`${repo}/calc.txt`, changed.join("\n") + "\n");

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e));
const logs = [];
page.on("console", (m) => {
  logs.push(`${m.type()}: ${m.text()}`);
  if (m.type() === "error") errors.push("console: " + m.text());
});
const shot = async (name) => { await page.waitForTimeout(700); await page.screenshot({ path: `${outDir}/${name}.png` }); console.log("shot", name); };
const check = (what, ok) => { console.log(ok ? "ok  " : "FAIL", what); if (!ok) errors.push("check: " + what); };

await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".log-row", { timeout: 30000 });
await page.click(".lp-tab:has-text('Commit')");
await page.waitForSelector(".cl-file:has-text('calc.txt')").catch(async (e) => {
  console.log("commit panel:", await page.textContent(".commit-tree"));
  console.log("status bar:", await page.textContent(".statusbar"));
  console.log("console:", JSON.stringify(logs), "errors:", JSON.stringify(errors));
  throw e;
});
// Only calc.txt goes into the commit.
await page.uncheck(".cl-header:has-text('Changes') .cl-check");
await page.check(".cl-file:has-text('calc.txt') .cl-check");
await page.click(".cl-file:has-text('calc.txt')");
await page.waitForSelector(".workspace .hunk-on");
check("two changes with check boxes", (await page.$$(".workspace .hunk-on")).length === 2);
await page.click(".workspace .hunk-on >> nth=1");
await page.waitForTimeout(400);
check("one change is unchecked", (await page.$$(".workspace .hunk-off")).length === 1);
check("the file check box shows a partial file", await page.$eval(".cl-file:has-text('calc.txt') .cl-check", (e) => e.indeterminate));
check("summary", (await page.textContent(".commit-summary")) === "1 file, 1 in part");
await shot("pc1-partial");
await page.fill(".commit-message", "Change line 2 only");
await page.click(".commit-button");
await page.waitForTimeout(2000);
const committed = git("show", "HEAD:calc.txt");
check("the commit has line 2 only", committed.includes("line 2 changed") && committed.includes("line 9\n") && !committed.includes("line 9 changed"));
check("the working tree keeps both changes", readFileSync(`${repo}/calc.txt`, "utf8") === changed.join("\n") + "\n");
check("line 9 is still a local change", git("diff", "--", "calc.txt").includes("+line 9 changed") && !git("diff", "--", "calc.txt").includes("line 2"));
check("other local changes stay", git("status", "--porcelain").includes(" M main.rs"));
await shot("pc2-committed");
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
