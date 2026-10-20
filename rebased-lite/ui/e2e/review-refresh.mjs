// UI scenario for the review window: it loads again when the branch gets a commit outside the app. The
// new file shows, the commit list grows, and the selected file stays in the same window.
// Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh, then:
// node e2e/review-refresh.mjs <repo> <screenshot-dir>.
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
const [,, repo, outDir] = process.argv;
const git = (...args) => execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
const blob = (text) => execFileSync("git", ["-C", repo, "hash-object", "-w", "--stdin"], { input: text, encoding: "utf8" }).trim();

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e));
const shot = async (name) => { await page.waitForTimeout(500); await page.screenshot({ path: `${outDir}/${name}.png` }); console.log("shot", name); };
const check = (what, ok) => { console.log(ok ? "ok  " : "FAIL", what); if (!ok) errors.push("check: " + what); };
const within = async (what, fn, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return check(what, true);
    await page.waitForTimeout(200);
  }
  check(what, false);
};
const files = () => page.$$eval(".review-window .review-file", (els) => els.map((e) => e.title).sort().join(","));
const selected = () => page.$eval(".review-window .review-file.selected", (e) => e.title).catch(() => "");
const commits = () => page.$$eval(".review-window .review-commit", (els) => els.length);

await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".sidebar .branch", { timeout: 30000 });
await page.click(".sidebar .branch:has-text('feature/cli') >> nth=0", { button: "right" });
await page.waitForTimeout(400);
await page.click(".menu-item:has-text('Review Branch')");
await page.waitForSelector(".dialog:has-text('Review Branch')");
await page.click(".dialog-buttons button:has-text('Start Review')");
await page.waitForSelector(".review-window .review-file.selected");
await within("the review shows cli.rs", async () => (await files()) === "cli.rs" && (await selected()) === "cli.rs");
const before = await commits();
await page.$eval(".review-window", (w) => (w.dataset.mark = "kept"));

// A commit on feature/cli outside the app, without a checkout: a new file docs/cli.md.
const env = { ...process.env, GIT_INDEX_FILE: `${repo}/.git/tmp-index` };
execFileSync("git", ["-C", repo, "read-tree", "feature/cli"], { env });
execFileSync("git", ["-C", repo, "update-index", "--add", "--cacheinfo", `100644,${blob("# CLI\n")},docs/cli.md`], { env });
const tree = execFileSync("git", ["-C", repo, "write-tree"], { env, encoding: "utf8" }).trim();
git("update-ref", "refs/heads/feature/cli", git("commit-tree", tree, "-p", "feature/cli", "-m", "Document the CLI"));

await within("the new file shows in the review", async () => (await files()) === "cli.rs,docs/cli.md");
check("the commit list has the new commit", (await commits()) === before + 1);
check("the selected file stays", (await selected()) === "cli.rs");
check("the window is the same, not a new one", (await page.$(".review-window[data-mark='kept']")) !== null);
await shot("rr1-review-refreshed");
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
