// UI scenario for the folders of a review: the box of a folder marks all of its files as viewed, a file
// that is not viewed makes the box half checked, and a second click marks all files as not viewed.
// Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh, then:
// node e2e/review-folders.mjs <repo> <screenshot-dir>.
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
const [,, repo, outDir] = process.argv;
const git = (...args) => execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
// A branch with three files in src/app and src/util, and one at the top.
const blob = (text) => execFileSync("git", ["-C", repo, "hash-object", "-w", "--stdin"], { input: text, encoding: "utf8" }).trim();
const env = { ...process.env, GIT_INDEX_FILE: `${repo}/.git/tmp-index` };
execFileSync("git", ["-C", repo, "read-tree", "main"], { env });
for (const p of ["src/app/view.rs", "src/app/model.rs", "src/util/text.rs", "notes.md"]) {
  execFileSync("git", ["-C", repo, "update-index", "--add", "--cacheinfo", `100644,${blob(`// ${p}\n`)},${p}`], { env });
}
const tree = execFileSync("git", ["-C", repo, "write-tree"], { env, encoding: "utf8" }).trim();
git("update-ref", "refs/heads/folders", git("commit-tree", tree, "-p", "main", "-m", "Add folders"));

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
const title = async () => ((await page.textContent(".review-window .review-files-title").catch(() => "")) ?? "");
const dirBox = (name) => `.review-window .review-dir:has(.dir-name:text-is('${name}')) input.review-viewed`;
const state = (sel) => page.$eval(sel, (b) => (b.indeterminate ? "half" : b.checked ? "on" : "off"));

await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".sidebar .branch", { timeout: 30000 });
await page.click(".sidebar .branch:has-text('folders') >> nth=0", { button: "right" });
await page.waitForTimeout(400);
await page.click(".menu-item:has-text('Review Branch')");
await page.waitForSelector(".dialog:has-text('Review Branch')");
await page.click(".dialog-buttons button:has-text('Start Review')");
await page.waitForSelector(".review-window .review-dir");
await within("the review lists 4 files", async () => (await title()).includes("0/4 viewed"));

// The box of src marks its three files.
await page.click(dirBox("src"));
await within("the folder box marks the 3 files of src", async () => (await title()).includes("3/4 viewed"));
check("the box of src is on", (await state(dirBox("src"))) === "on");
check("the box of src/app is on too", (await state(dirBox("app"))) === "on");

// One file not viewed: the folders are half checked.
await page.click(".review-window .review-file:has-text('model.rs') input.review-viewed");
await within("a file is not viewed again", async () => (await title()).includes("2/4 viewed"));
check("the box of src is half checked", (await state(dirBox("src"))) === "half");
await shot("rf1-folder-viewed");

// A click on a half checked box marks all files of the folder.
await page.click(dirBox("src"));
await within("all files of src are viewed", async () => (await title()).includes("3/4 viewed"));
await page.click(dirBox("src"));
await within("a second click marks them as not viewed", async () => (await title()).includes("0/4 viewed"));
check("the folder stays open after a click on its box", (await page.$$(".review-window .review-file")).length === 4);
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
