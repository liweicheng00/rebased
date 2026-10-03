// UI scenario for Compare Branches: the commits of each side, the changed files and their diff, the
// common-ancestor mode, swap, and the working tree as the right side.
// Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh, then:
// node e2e/compare-branches.mjs <repo> <screenshot-dir>.
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
const groups = () => page.$$eval(".compare-group-title", (e) => e.map((x) => x.textContent));
const fileNames = () => page.$$eval(".compare-file", (e) => e.map((x) => x.textContent));

await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".sidebar .branch", { timeout: 30000 });

// main and feature/cli.
await page.click(".group-header:has-text('Local') ~ .branch:has-text('feature/cli') >> nth=0", { button: "right" });
await page.click(".menu-item:has-text('Compare Branches: main and feature/cli')");
await page.waitForSelector(".compare-commit");
const onlyCli = git("log", "--format=%s", "main..feature/cli").split("\n").filter(Boolean);
const onlyMain = git("log", "--format=%s", "feature/cli..main").split("\n").filter(Boolean);
await within("both commit groups show with their counts", async () => {
  const g = await groups();
  return g.length === 2 && g[0].includes("In main, not in feature/cli") && g[0].endsWith(String(onlyMain.length)) && g[1].endsWith(String(onlyCli.length));
});
check("the commits of feature/cli show", (await page.textContent(".compare-group >> nth=1")).includes(onlyCli[0]));
const tipFiles = git("diff", "--name-only", "main", "feature/cli").split("\n").filter(Boolean);
await within("the changed files between the tips show", async () => (await fileNames()).length === tipFiles.length);
await within("the diff of the first file shows", async () => (await page.$$(".compare-file.selected")).length === 1 && (await page.textContent(".diff-title")).length > 0);
await shot("cmp1-compare-branches");

// The splitter between the commits and the files: a drag makes the commits shorter.
const commitsHeight = () => page.$eval(".compare-commits", (e) => Math.round(e.getBoundingClientRect().height));
const h0 = await commitsHeight();
const g = await page.$eval(".compare-side .column-grip", (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 2 }; });
await page.mouse.move(g.x, g.y);
await page.mouse.down();
await page.mouse.move(g.x, g.y - 120, { steps: 5 });
await page.mouse.up();
const h1 = await commitsHeight();
check("the drag makes the commits shorter", h1 < h0 - 100);

// From the common ancestor: only the changes of feature/cli.
await page.selectOption(".compare-header select >> nth=2", "base");
const baseFiles = git("diff", "--name-only", "main...feature/cli").split("\n").filter(Boolean);
await within("the files since the common ancestor show", async () => (await fileNames()).length === baseFiles.length);

// Swap.
await page.click(".compare-header button:has-text('⇄')");
await within("swap exchanges the sides", async () => (await groups())[0]?.includes("In feature/cli, not in main"));

// The working tree on the right: the local change of main.rs shows.
await page.selectOption(".compare-header select >> nth=0", "main");
await page.selectOption(".compare-header select >> nth=2", "tips");
await page.selectOption(".compare-header select >> nth=1", { label: "Working tree" });
await within("the working tree shows its local change", async () => (await fileNames()).some((f) => f.includes("main.rs")));

// Double-click a commit: the window closes and the log selects it.
await page.selectOption(".compare-header select >> nth=1", "feature/cli");
await page.waitForSelector(".compare-group >> nth=1 >> .compare-commit");
await page.dblclick(".compare-group >> nth=1 >> .compare-commit >> nth=0");
await within("the window closes", async () => (await page.$(".compare-header")) === null);
await within("the log selects the commit", async () => (await page.textContent(".log-row.selected").catch(() => "")).includes(onlyCli[0]));

// The window opens again with the height of the drag.
await page.click(".group-header:has-text('Local') ~ .branch:has-text('feature/cli') >> nth=0", { button: "right" });
await page.click(".menu-item:has-text('Compare Branches: main and feature/cli')");
await page.waitForSelector(".compare-commit");
check("the height stays", Math.abs((await commitsHeight()) - h1) < 3);
await page.keyboard.press("Escape");
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
