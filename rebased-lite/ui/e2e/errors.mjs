// UI scenario for the kinds of errors: a locked repository gets a notification that says what to do.
// Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh, then:
// node e2e/errors.mjs <repo> <screenshot-dir>.
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
const [,, repo, outDir] = process.argv;
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).replace(/\s+$/, "");
git("config", "commit.gpgsign", "false");

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

await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".log-row", { timeout: 30000 });
await page.click(".lp-tab:has-text('Changes')");
await page.waitForSelector(".cl-file:has-text('main.rs')");

// Another git program holds the index: the commit fails with a hint.
writeFileSync(`${repo}/.git/index.lock`, "");
const head = git("rev-parse", "HEAD");
await page.fill(".commit-message", "Blocked by a lock");
await page.keyboard.press("Control+Enter");
await within("the failure says what to do", async () => ((await page.textContent(".toasts").catch(() => "")) ?? "").includes("Another git program uses the repository"));
check("no commit is made", git("rev-parse", "HEAD") === head);
await shot("err1-locked");

// Without the lock, the same commit works.
rmSync(`${repo}/.git/index.lock`);
await page.click(".toast-close >> nth=0").catch(() => {});
await page.fill(".commit-message", "After the lock");
await page.keyboard.press("Control+Enter");
await within("the commit works without the lock", async () => git("log", "-1", "--format=%s") === "After the lock");
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
