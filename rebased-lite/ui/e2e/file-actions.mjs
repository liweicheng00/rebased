// UI scenario for Revert Selected Changes, Cherry-Pick Selected Changes and Get from Revision.
// Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh, then:
// node e2e/file-actions.mjs <repo> <screenshot-dir>. The scenario changes the repository.
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
const fileMenu = async (commit, file, item) => {
  await page.click(`.log-row:has-text("${commit}")`);
  await page.waitForSelector(`.changes .change:has-text('${file}')`);
  await page.click(`.changes .change:has-text('${file}')`, { button: "right" });
  await page.click(`.menu-item:has-text('${item}')`);
};

await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".log-row", { timeout: 30000 });

// Revert "Greet the world" for main.rs; the local change at the end of main.rs stays.
await page.click(`.log-row:has-text("Greet the world")`);
await page.waitForSelector(".changes .change:has-text('main.rs')");
await page.click(".changes .change:has-text('main.rs')", { button: "right" });
await shot("fa1-menu");
await page.click(".menu-item:has-text('Revert Selected Changes')");
await page.waitForTimeout(1500);
const main = readFileSync(`${repo}/main.rs`, "utf8");
check("main.rs reverted and keeps the local change", main.includes('println!("hello");') && main.includes("fn helper() {}"));
await clearToasts();

// Cherry-pick cli.rs from feature/cli into the working tree of main.
await fileMenu("Add a CLI entry point", "cli.rs", "Cherry-Pick Selected Changes");
await page.waitForTimeout(1500);
check("cli.rs is in the working tree", existsSync(`${repo}/cli.rs`));
await clearToasts();

// Get README.md from the initial commit.
await fileMenu("Initial commit", "README.md", "Get from Revision");
await page.click(".dialog-buttons button:has-text('Get')");
await page.waitForTimeout(1500);
check("README.md has its first version", readFileSync(`${repo}/README.md`, "utf8") === git("show", `${git("rev-list", "--max-parents=0", "HEAD")}:README.md`) + "\n");
await page.click(".lp-tab:has-text('Changes')");
await page.waitForTimeout(800);
const tree = (await page.textContent(".commit-tree")).replace(/\s+/g, " ");
console.log("local changes:", tree);
check("the local changes list the three files", tree.includes("main.rs") && tree.includes("cli.rs") && tree.includes("README.md"));
await shot("fa2-local-changes");

// Compare branches as commit lists.
await page.click(".lp-tab:has-text('Branches')");
await page.click(".branch:has(.branch-name:text-is('feature/cli'))", { button: "right" });
await page.click(".menu-item:has-text('Show Commits Not in main')");
await page.waitForTimeout(2000);
const subjects = await page.$$eval(".log-row .subject-text", (e) => e.map((x) => x.textContent));
console.log("not in main:", subjects);
check("feature/cli has two commits that are not in main", subjects.join("|") === "Print arguments one per line|Add a CLI entry point");
check("the filter button names the range", (await page.textContent(".filter-bar .filter-button")).includes("feature/cli not in main"));
await shot("fa3-not-in-main");
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
