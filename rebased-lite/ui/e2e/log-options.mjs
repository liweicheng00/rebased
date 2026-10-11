// UI scenario for the options of the log: the Regex and Match Case options of the text filter, No Merges,
// the highlighters (my commits, merge commits, the current branch), Commit Timestamp and Go to Child.
// Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh, then:
// node e2e/log-options.mjs <repo> <screenshot-dir>.
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
const [,, repo, outDir] = process.argv;
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
git("config", "user.email", "grace@example.com");

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e));
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
const subjects = () => page.$$eval(".log-row .subject-text", (els) => els.map((e) => e.textContent));
const count = async () => (await subjects()).length;
const viewOption = async (label) => {
  await page.click(".tb-button:has-text('View')");
  await page.click(`.menu-item:has-text('${label}')`);
};

await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".log-row", { timeout: 30000 });
const all = await count();

// A fixed string does not take a pattern; with Regex it does.
await page.fill(".filter-text", "Add (math|a binary)");
await page.press(".filter-text", "Enter");
await within("a fixed string with a pattern matches nothing", async () => (await count()) === 0);
await page.click(".filter-opt:has-text('.*')");
await within("Regex matches the two commits", async () => {
  const s = await subjects();
  return s.length === 2 && s.includes("Add math module") && s.includes("Add a binary logo");
});
check("the Regex option shows on", (await page.$(".filter-opt.on:has-text('.*')")) !== null);

// Match Case: "add" in lower case matches nothing then.
await page.fill(".filter-text", "add (math|a binary)");
await page.press(".filter-text", "Enter");
await within("the case does not count at first", async () => (await count()) === 2);
await page.click(".filter-opt:has-text('Aa')");
await within("Match Case matches nothing", async () => (await count()) === 0);
await page.click(".filter-opt:has-text('Aa')");
await page.click(".filter-opt:has-text('.*')");
await page.click(".filter-clear");
await within("Clear shows all commits again", async () => (await count()) === all);

// No Merges.
const merges = git("rev-list", "--merges", "--count", "--branches", "--remotes", "--tags", "HEAD");
await page.click(".filter-button:has-text('Branch')");
await page.click(".menu-item:has-text('No Merges')");
await within("No Merges hides the merge commits", async () => (await count()) === all - Number(merges) && !(await subjects()).some((s) => s.startsWith("Merge")));
check("the branch button says so", ((await page.textContent(".filter-button.active")) ?? "").includes("no merges"));
await page.click(".filter-button .filter-x");
await within("the ✕ shows the merges again", async () => (await count()) === all);

// The highlighters.
await viewOption("My Commits");
await within("My Commits marks the commits of grace@example.com", async () => {
  const mine = await page.$$eval(".log-row.hl-mine .subject-text", (els) => els.map((e) => e.textContent));
  return mine.length > 0 && mine.every((s) => /parser|CLI|commas/i.test(s));
});
await viewOption("Merge Commits");
await within("Merge Commits marks the merges", async () => (await page.$$(".log-row.hl-merge")).length === Number(merges));
await viewOption("Current Branch");
await within("Current Branch dims the commits that HEAD does not reach", async () => {
  const other = await page.$$eval(".log-row.hl-other .subject-text", (els) => els.map((e) => e.textContent));
  return other.includes("Add a CLI entry point") && !other.includes("Initial commit");
});
await shot("lo1-highlight");

// Commit Timestamp: the Date column shows the commit time.
const authorDate = await page.textContent(".log-row:has-text('Add a local README note') .date");
git("commit", "-q", "--allow-empty", "-m", "Later commit");
await page.waitForTimeout(1500);
await viewOption("Commit Timestamp");
await within("the date column takes the commit time", async () => ((await page.textContent(".log-row .date >> nth=0")) ?? "") !== authorDate && ((await page.getAttribute(".log-row .date >> nth=0", "title")) ?? "").includes("commit time"));

// Go to Child: the child of the initial commit.
await page.click(".log-row:has-text('Initial commit')", { button: "right" });
await page.click(".menu-item:has-text('Go to Child')");
await within("Go to Child selects the child", async () => ((await page.textContent(".log-row.selected .subject-text")) ?? "") === "Add math module");
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
