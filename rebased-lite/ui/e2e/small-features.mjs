// UI scenario for favorite branches, Sign-off, the commit message history and Edit Author.
// Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh, then:
// node e2e/small-features.mjs <repo> <screenshot-dir>. The scenario changes the repository.
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
const [,, repo, outDir] = process.argv;
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).replace(/\s+$/, "");
git("config", "commit.gpgsign", "false");

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
const localRow = (name) => `.group-header:has-text('Local') ~ .branch:has-text('${name}') >> nth=0`;

await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".sidebar .branch", { timeout: 30000 });

// Favorites: main is a favorite at first; add fix/readme, then show only the favorites.
check("main is a favorite at first", (await page.$(".branch.favorite:has-text('main')")) !== null);
await page.hover(localRow("fix/readme"));
await page.click(`${localRow("fix/readme")} >> .fav-toggle`);
await within("fix/readme is a favorite", async () => (await page.$(".group-header:has-text('Local') ~ .branch.favorite:has-text('fix/readme')")) !== null);
const localNames = () => page.$$eval(".sidebar-list .branch-local .branch-name", (e) => e.map((x) => x.textContent));
const before = await localNames();
await page.click(".fav-filter");
await within("only favorites and the current branch show", async () => {
  const names = await localNames();
  return names.length > 0 && names.length < before.length && !names.includes("feature/cli");
});
await shot("sf1-favorites");
await page.click(".fav-filter");

// Commit with Sign-off.
await page.click(".lp-tab:has-text('Changes')");
await page.waitForSelector(".cl-file:has-text('main.rs')");
await page.check(".commit-amend:has-text('Sign-off') input");
await page.click(".cl-header:has-text('Changes') .cl-check");
if (!(await page.isChecked(".cl-header:has-text('Changes') .cl-check"))) await page.click(".cl-header:has-text('Changes') .cl-check");
await page.fill(".commit-message", "Add the helper");
await page.keyboard.press("Control+Enter");
await within("the commit is made", async () => git("log", "-1", "--format=%s") === "Add the helper");
check("the commit has Signed-off-by", git("log", "-1", "--format=%b").includes("Signed-off-by: "));

// The message history offers the last message.
appendFileSync(`${repo}/main.rs`, "// more\n");
await within("the next change shows", async () => (await page.$(".cl-file:has-text('main.rs')")) !== null);
await page.click(".commit-history");
await page.click(".menu-item:has-text('Add the helper')");
check("the history fills the message", (await page.inputValue(".commit-message")) === "Add the helper\n\nSigned-off-by: Ada Lovelace <ada@example.com>" || (await page.inputValue(".commit-message")).startsWith("Add the helper"));
await page.fill(".commit-message", "");

// Edit Author of the last commit.
await page.click(".log-row >> nth=0", { button: "right" });
await page.click(".menu-item:has-text('Edit Author')");
await page.fill(".dialog-field:has-text('Author') input", "Grace Hopper <grace@example.com>");
await page.click(".dialog-buttons button:has-text('Save')");
await within("the author changes", async () => git("log", "-1", "--format=%an <%ae>") === "Grace Hopper <grace@example.com>");
check("the message stays", git("log", "-1", "--format=%s") === "Add the helper");
await shot("sf2-author");
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
