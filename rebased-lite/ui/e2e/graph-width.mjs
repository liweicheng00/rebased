// UI scenario for the width of the graph column: drag the left edge of the Subject header to make the
// subject cover a wide graph, keep the width after a reload, and show all of the graph with a double click.
// Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh, then:
// node e2e/graph-width.mjs <repo> <screenshot-dir>.
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
const [,, repo, outDir] = process.argv;
const wt = `${repo}-wt`;
const git = (dir, ...args) => execFileSync("git", ["-C", dir, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
// Eight branches from one commit, then merged one by one: the graph has many lanes.
git(repo, "worktree", "add", "-q", "--detach", wt, "main");
const start = git(wt, "rev-parse", "HEAD");
for (let i = 1; i <= 8; i++) {
  git(wt, "checkout", "-q", "-b", `wide-${i}`, start);
  git(wt, "commit", "-q", "--allow-empty", "-m", `Wide work ${i}`);
}
git(wt, "checkout", "-q", "-b", "wide-all", start);
for (let i = 1; i <= 8; i++) git(wt, "merge", "-q", "--no-ff", "-m", `Merge wide ${i}`, `wide-${i}`);
git(repo, "worktree", "remove", "--force", wt);

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1.5 })).newPage();
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
const cell = () => page.$eval(".log-row .graph-cell", (e) => e.getBoundingClientRect().width);
const canvas = () => page.$eval(".log-row canvas", (e) => e.getBoundingClientRect().width);
const subjectLeft = () => page.$eval(".log-row .subject", (e) => e.getBoundingClientRect().left);
const headerLeft = () => page.$eval(".log-header .hcol.subject", (e) => e.getBoundingClientRect().left);

await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".log-row", { timeout: 30000 });
await page.click(".sidebar .branch:has-text('wide-all')");
await page.waitForTimeout(800);
const full = await canvas();
check("the graph is wide", full > 120);
check("all of the graph shows at first", Math.abs((await cell()) - full) < 1);
check("the header lines up with the subject", Math.abs((await headerLeft()) - (await subjectLeft())) < 1);
await shot("gw1-full");

// Drag the left edge of the Subject header to the left.
const grip = await page.$eval(".log-header .hcol.subject .hgrip", (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
await page.mouse.move(grip.x, grip.y);
await page.mouse.down();
await page.mouse.move(grip.x - 100, grip.y, { steps: 5 });
await page.mouse.up();
await within("the drag makes the graph column narrower", async () => Math.abs((await cell()) - (full - 100)) < 2);
check("the canvas keeps its size, and the subject covers the rest", Math.abs((await canvas()) - full) < 1);
check("the header follows", Math.abs((await headerLeft()) - (await subjectLeft())) < 1);
await shot("gw2-narrow");

// The width stays after a reload.
await page.reload();
await page.waitForSelector(".log-row", { timeout: 30000 });
await within("the width stays after a reload", async () => Math.abs((await cell()) - (full - 100)) < 2);

// A double click shows all of the graph again.
await page.dblclick(".log-header .hcol.subject .hgrip");
await within("a double click shows all of the graph", async () => Math.abs((await cell()) - (await canvas())) < 1);
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
