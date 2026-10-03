// UI scenario for Review Branch: start a review, mark a file as viewed, add a note, switch between
// reviews, and merge from the Reviews tab with Squash, then Undo.
// Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh, then:
// node e2e/review.mjs <repo> <screenshot-dir>.
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
const [,, repo, outDir] = process.argv;
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).replace(/\s+$/, "");
const has = (b) => git("branch", "--list", b) !== "";
git("config", "commit.gpgsign", "false");

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e));
page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));
const shot = async (name) => { await page.waitForTimeout(600); await page.screenshot({ path: `${outDir}/${name}.png` }); console.log("shot", name); };
const check = (what, ok) => { console.log(ok ? "ok  " : "FAIL", what); if (!ok) errors.push("check: " + what); };
const within = async (what, fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return check(what, true);
    await page.waitForTimeout(200);
  }
  check(what, false);
};
const text = async (sel) => ((await page.textContent(sel).catch(() => "")) ?? "");
const files = () => page.$$eval(".review-window .review-file .rebase-subject", (els) => els.map((e) => e.textContent).join(","));

await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".sidebar .branch", { timeout: 30000 });

// Start a review from the context menu of a branch.
await page.click(".sidebar .branch:has-text('feature/cli') >> nth=0", { button: "right" });
await page.click(".menu-item:has-text('Review Branch')");
await page.waitForSelector(".dialog:has-text('Review Branch')");
check("the base is main", (await page.inputValue(".dialog select >> nth=1")) === "main");
await page.click(".dialog-buttons button:has-text('Start Review')");
await page.waitForSelector(".review-window");
// From the merge base: logo.bin came to main later, so it is not a change of the branch.
await within("the review shows the changes of the branch only", async () => (await files()) === "cli.rs");
check("two commits", (await page.$$(".review-window .review-commit")).length === 3);
await within("no conflicts", async () => (await text(".review-status")).includes("No conflicts with main"));

// Viewed, and a note on the line of the cursor.
await page.click(".review-window .review-file input.review-viewed");
await within("the file is viewed", async () => (await text(".review-window .compare-files-title >> nth=1")).includes("1/1 viewed"));
await page.fill(".review-note-text", "Use a logger here");
await page.press(".review-note-text", "Control+Enter");
await within("the note shows", async () => (await text(".review-notes-list")).includes("Use a logger here"));
await within("the diff marks the line", async () => (await page.$$(".review-window .review-note-bar")).length > 0);
await shot("rv1-review");

// One commit only.
await page.click(".review-window .review-commit >> nth=1");
await within("a commit shows its files without the viewed box", async () => (await files()) === "cli.rs" && (await page.$$(".review-window .review-viewed")).length === 0);
await page.keyboard.press("Escape");
await page.waitForSelector(".review-window", { state: "detached" });

// A second review from the Reviews tab, then switch between the two.
// The tabs of the left pane: Mod+1 to Mod+4.
for (const [key, panel] of [["2", ".commit-panel"], ["3", ".stash-panel"], ["1", ".sidebar"]]) {
  await page.keyboard.press(`Control+${key}`);
  await within(`Mod+${key} shows ${panel}`, async () => !(await page.$eval(panel, (e) => e.hidden)));
}
await page.keyboard.press("Control+4");
await page.waitForSelector(".review-panel:not([hidden])");
await page.click(".review-panel button:has-text('New Review')");
await page.selectOption(".dialog select >> nth=0", "topic/readme");
check("a new review proposes main as the base", (await page.inputValue(".dialog select >> nth=1")) === "main");
await page.click(".dialog-buttons button:has-text('Start Review')");
await within("the second review opens", async () => (await files()) === "README.md");
await page.selectOption(".review-switcher", "feature/cli");
await within("the switcher opens the first review", async () => (await files()) === "cli.rs");
await page.keyboard.press("Escape");
await within("the tab lists both reviews", async () => (await page.$$(".review-row")).length === 2);
check("the tab counts the open reviews", (await text(".lp-tab:has-text('Reviews')")).includes("2"));
await shot("rv2-list");

// Merge from the list with Squash, and delete the branch.
const main = git("rev-parse", "main");
await page.click(".review-row:has-text('feature/cli') .review-finish");
await page.waitForSelector(".dialog:has-text('Merge feature/cli')");
await page.click(".review-mode:has-text('Squash') input");
check("the squash message lists the commits", (await page.inputValue(".review-merge-message")).includes("* Add a CLI entry point"));
await shot("rv3-merge-dialog");
await page.click(".dialog-buttons button:has-text('Merge')");
await within("main gets one new commit", async () => git("rev-parse", "main^") === main);
check("main has the file", git("show", "main:cli.rs").includes("pub fn run"));
check("the branch is deleted", !has("feature/cli"));
await within("the review shows as merged", async () => (await text(".review-row:has-text('feature/cli')")).includes("merged"));
check("the other local changes stay", git("status", "--porcelain").includes("main.rs"));
await shot("rv4-merged");

// Undo puts back main and the branch.
await page.click(".toast button:has-text('Undo')");
await within("Undo puts back main", async () => git("rev-parse", "main") === main);
check("Undo puts back the branch", has("feature/cli"));
// A review with folders shows a tree: one row for src/app, closed with a click.
git("branch", "-q", "feature/tree", "main");
const tmp = `${repo}-tree`;
execFileSync("git", ["-C", repo, "worktree", "add", "-q", tmp, "feature/tree"]);
for (const f of ["src/app/one.rs", "src/app/two.rs", "top.txt"]) {
  execFileSync("mkdir", ["-p", `${tmp}/${f.slice(0, f.lastIndexOf("/") + 1) || "."}`]);
  execFileSync("sh", ["-c", `echo x > '${tmp}/${f}'`]);
}
execFileSync("git", ["-C", tmp, "add", "."]);
execFileSync("git", ["-C", tmp, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "Tree files"]);
execFileSync("git", ["-C", repo, "worktree", "remove", "--force", tmp]);
await page.click(".tb-button:has-text('Refresh')");
await page.keyboard.press("Control+1");
await page.waitForSelector(".sidebar .branch:has-text('feature/tree')");
await page.keyboard.press("Control+4");
await page.click(".review-panel button:has-text('New Review')");
await page.waitForSelector(".dialog:has-text('Review Branch')");
await page.selectOption(".dialog select >> nth=0", "feature/tree");
await page.click(".dialog-buttons button:has-text('Start Review')");
await within("the tree has a row for src/app", async () => ((await page.textContent(".review-window .review-dir").catch(() => "")) ?? "").includes("src/app"));
check("the files under it come first", (await files()) === "one.rs,two.rs,top.txt");
await shot("rv5-tree");
await page.click(".review-window .review-dir");
await within("a click closes the folder", async () => (await files()) === "top.txt");
await page.click(".review-tree-toggle");
await within("the flat list shows all files", async () => (await files()) === "src/app/one.rs,src/app/two.rs,top.txt".split(",").map((p) => p.split("/").pop()).join(","));
await page.click(".review-tree-toggle");
await page.keyboard.press("Escape");

// A remote branch: the review works, and Merge keeps the remote branch.
const newReview = async (branch, base) => {
  await page.click(".review-panel button:has-text('New Review')");
  await page.waitForSelector(".dialog:has-text('Review Branch')");
  await page.selectOption(".dialog select >> nth=0", branch);
  await page.selectOption(".dialog select >> nth=1", base);
  await page.click(".dialog-buttons button:has-text('Start Review')");
  await page.waitForSelector(".review-window");
};
await newReview("origin/feature/cli", "main");
await within("the remote branch shows its changes", async () => (await files()).includes("cli.rs"));
await within("Merge is on for a local base", async () => !(await page.isDisabled(".review-window .review-merge")));
await page.click(".review-window .review-merge");
await page.waitForSelector(".dialog:has-text('Merge origin/feature/cli')");
check("no delete box for a remote branch", !((await text(".dialog")) ?? "").includes("Delete the branch"));
await shot("rv6-remote");
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");
await page.waitForSelector(".review-window", { state: "detached" });
// A remote base: the review shows, and Merge is off.
await newReview("feature/tree", "origin/main");
await within("the remote base shows", async () => (await text(".review-window .merge-header")).includes("origin/main"));
check("Merge is off for a remote base", await page.isDisabled(".review-window .review-merge"));
await page.keyboard.press("Escape");
await within("the panel lists the remote review", async () => (await text(".review-panel")).includes("origin/feature/cli"));
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
