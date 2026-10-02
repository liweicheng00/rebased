// UI scenario for the web page of a remote: the toolbar button, a branch, a commit and a remote group open
// the right page, and a remote without a web page shows a notice.
// Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh, then:
// node e2e/open-remote.mjs <repo> <screenshot-dir>.
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
const [,, repo, outDir] = process.argv;
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).replace(/\s+$/, "");
const localUrl = git("remote", "get-url", "origin");
git("remote", "set-url", "origin", "git@github.com:acme/demo.git");

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 });
// In a browser the page opens a new tab; the scenario records the address instead.
await context.addInitScript(() => {
  window.__opened = [];
  window.open = (url) => {
    window.__opened.push(String(url));
    return null;
  };
});
const page = await context.newPage();
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
const last = () => page.evaluate(() => window.__opened.at(-1) ?? "");

await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".sidebar .branch", { timeout: 30000 });

// The toolbar button: main tracks origin/main.
await page.click(".tb-button:has-text('Remote')");
await within("the button opens the current branch", async () => (await last()) === "https://github.com/acme/demo/tree/main");

// A local branch opens its tracked branch.
await page.click(".sidebar .branch:has-text('feature/cli') >> nth=0", { button: "right" });
await shot("or1-branch-menu");
await page.click(".menu-item:has-text('Open origin/feature/cli in the Browser')");
await within("a branch opens its tracked branch", async () => (await last()) === "https://github.com/acme/demo/tree/feature/cli");

// A commit.
const oid = git("rev-parse", "HEAD");
await page.click(`.log-row:has-text('${git("log", "-1", "--format=%s").slice(0, 20)}')`, { button: "right" });
await page.click(".menu-item:has-text('Open Commit in the Browser')");
await within("a commit opens its page", async () => (await last()) === `https://github.com/acme/demo/commit/${oid}`);

// The group of a remote opens the home page.
await page.click(".group-header:has-text('Remote: origin')", { button: "right" });
await page.click(".menu-item:has-text('Open origin in the Browser')");
await within("a remote opens its home page", async () => (await last()) === "https://github.com/acme/demo");

// A remote on a local path has no web page.
git("remote", "set-url", "origin", localUrl);
const before = (await page.evaluate(() => window.__opened.length));
await page.click(".tb-button:has-text('Remote')");
await within("a local remote shows a notice", async () => ((await page.textContent(".toasts").catch(() => "")) ?? "").includes("has no web page"));
check("nothing opens", (await page.evaluate(() => window.__opened.length)) === before);
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
