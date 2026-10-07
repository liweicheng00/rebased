// UI scenario for a reload after a change outside the app: the log keeps its place and its selection, the
// file list and the diff stay, and a diff of a local change stays too.
// Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh, then:
// node e2e/reload-keeps-place.mjs <repo> <screenshot-dir>.
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
const [,, repo, outDir] = process.argv;
const git = (...args) => execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
// Many commits on a side branch, so the log scrolls.
let tip = git("rev-parse", "main");
const tree = git("rev-parse", "main^{tree}");
for (let i = 1; i <= 80; i++) tip = git("commit-tree", tree, "-p", tip, "-m", `Side work ${i}`);
git("update-ref", "refs/heads/side", tip);
/** A new commit on top of the log, as a tool outside the app makes it. */
const commitOutside = (name) => git("update-ref", `refs/heads/${name}`, git("commit-tree", tree, "-p", tip, "-m", `Outside ${name}`));

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e));
const shot = async (name) => { await page.waitForTimeout(500); await page.screenshot({ path: `${outDir}/${name}.png` }); console.log("shot", name); };
const check = (what, ok) => { console.log(ok ? "ok  " : "FAIL", what); if (!ok) errors.push("check: " + what); };
const within = async (what, fn, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return check(what, true);
    await page.waitForTimeout(200);
  }
  check(what, false);
};
const rowCount = async () => Number((((await page.textContent(".statusbar")) ?? "").match(/(\d+) commits/) ?? [])[1] ?? 0);
const selected = () => page.$eval(".log-row.selected", (e) => ({ text: e.textContent, top: e.getBoundingClientRect().top })).catch(() => null);
const diffTitle = async () => ((await page.textContent(".diff .diff-title").catch(() => "")) ?? "").trim();

await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".log-row", { timeout: 30000 });

// Scroll down, choose a commit with two files, and open its second file. Initial commit is the last row.
await page.$eval(".log-scroll", (e) => (e.scrollTop = e.scrollHeight - e.clientHeight - 120));
await page.waitForTimeout(500);
await page.click(".log-row:has-text('Initial commit')");
await page.waitForSelector(".changes-panel .change >> nth=1");
await page.click(".changes-panel .change >> nth=1");
await page.waitForTimeout(800);
const before = await selected();
const fileBefore = await diffTitle();
const commits = await rowCount();
check("a file of the commit shows", fileBefore !== "");

// A commit outside the app: the log reloads with one more row on top.
commitOutside("outside-1");
await within("the log reloads with the new commit", async () => (await rowCount()) === commits + 1);
await page.waitForTimeout(800);
const after = await selected();
check("the same commit stays selected", after?.text === before?.text);
check("it stays at the same height on the screen", !!after && !!before && Math.abs(after.top - before.top) < 2);
check("the diff keeps its file", (await diffTitle()) === fileBefore);
check("the file list keeps the chosen file", ((await page.textContent(".changes-panel .change.active, .changes-panel .change.selected").catch(() => "")) ?? "") !== "");
await shot("rk1-after-reload");

// A diff of a local change stays after a reload.
await page.keyboard.press("Control+2");
await page.click(".cl-file:has(.path:text-is('main.rs'))");
await within("the local diff shows", async () => (await diffTitle()).includes("main.rs") && ((await page.textContent(".diff .diff-sides")) ?? "").includes("working tree"));
commitOutside("outside-2");
await within("the log reloads again", async () => (await rowCount()) === commits + 2);
await page.waitForTimeout(800);
check("the local diff stays", (await diffTitle()).includes("main.rs") && ((await page.textContent(".diff .diff-sides")) ?? "").includes("working tree"));
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
