// UI scenario for Remove Worktree: the dialog names what stops git, the files that no .gitignore covers
// and a lock, and the removal then works. A clean worktree goes with a plain Remove.
// Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh, then:
// node e2e/worktree-remove.mjs <repo> <screenshot-dir>. The scenario makes worktrees next to <repo>.
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
const [,, repo, outDir] = process.argv;
if (!repo || !outDir) throw new Error("usage: node e2e/worktree-remove.mjs <repo> <screenshot-dir>");
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const wt = (name) => `${repo}-wt-${name}`;
for (const name of ["clean", "files", "locked"]) {
  rmSync(wt(name), { recursive: true, force: true });
  git("worktree", "add", "-q", "-b", `wt-${name}`, wt(name), "main");
}
// Files that an editor and Finder make: no .gitignore covers them.
writeFileSync(`${wt("files")}/.DS_Store`, "x");
mkdirSync(`${wt("files")}/.idea`, { recursive: true });
writeFileSync(`${wt("files")}/.idea/workspace.xml`, "x");
git("worktree", "lock", "--reason", "on a USB disk", wt("locked"));

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
const dialogText = async () => ((await page.textContent(".dialog")) ?? "").replace(/\s+/g, " ");
const openDialog = async (name) => {
  await page.click(`.sidebar .worktree:has(.branch-name:text-is('${wt(name).split("/").pop()}'))`, { button: "right" });
  await page.click(".menu-item:has-text('Remove Worktree')");
  await page.waitForSelector(".dialog:has-text('Remove Worktree')");
};

await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".sidebar .worktree", { timeout: 30000 });

// Untracked files: the dialog lists them, says why, and Remove Anyway removes the worktree.
await openDialog("files");
const files = await dialogText();
check("the dialog lists the files that git counts", files.includes("?? .DS_Store") && files.includes("?? .idea/"));
check("it says why an editor can hide them", files.includes("no .gitignore covers"));
check("the button is Remove Anyway", (await page.textContent(".dialog-buttons button.danger")) === "Remove Anyway");
await shot("wr1-files");
await page.click(".dialog-buttons button:has-text('Remove Anyway')");
await within("the worktree with files is removed", async () => !existsSync(wt("files")));

// A lock: the dialog names the reason, and Unlock and Remove removes the worktree.
await openDialog("locked");
check("the dialog names the lock and its reason", (await dialogText()).includes("locked: on a USB disk"));
await page.click(".dialog-buttons button:has-text('Unlock and Remove')");
await within("the locked worktree is removed", async () => !existsSync(wt("locked")));

// A clean worktree: a plain Remove.
await openDialog("clean");
check("a clean worktree has no reasons", !(await dialogText()).includes("Git counts"));
await page.click(".dialog-buttons button:text-is('Remove')");
await within("the clean worktree is removed", async () => !existsSync(wt("clean")));
check("the branches stay", git("branch", "--list", "wt-*").split("\n").length === 3);
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
