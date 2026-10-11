// UI scenario for the history edits of the log: Extract Selected Changes to Separate Commit, Drop Selected
// Changes, Fixup… with the autosquash of Interactively Rebase, Push All up to Here, and the Rebase dialog.
// Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh, then:
// node e2e/history-edit.mjs <repo> <screenshot-dir>.
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const [,, repo, outDir] = process.argv;
const git = (...args) => execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
// main at origin/main without local changes, then two commits of its own.
// The origin has main checked out; the push only moves its ref.
execFileSync("git", ["-C", `${repo}-origin`, "config", "receive.denyCurrentBranch", "ignore"]);
git("stash", "-q", "-u");
git("reset", "-q", "--hard", "origin/main");
for (const f of ["x.txt", "y.txt", "z.txt"]) writeFileSync(`${repo}/${f}`, `${f}\n`);
git("add", "x.txt", "y.txt", "z.txt");
git("commit", "-q", "-m", "Mixed work");
writeFileSync(`${repo}/top.txt`, "top\n");
git("add", "top.txt");
git("commit", "-q", "-m", "Top work");
const filesOf = (rev) => git("diff-tree", "--no-commit-id", "--name-only", "-r", rev).split("\n").filter(Boolean).sort().join(",");

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
const row = (subject) => `.log-row:has(.subject-text:text-is("${subject}"))`;
/** Clicks a menu item. The menu ignores a click right after it opens. */
const menu = async (label) => {
  await page.waitForTimeout(400);
  await page.click(`.menu-item:has-text("${label}")`);
};
const fileOfCommit = (name) => `.changes-panel .change:has(.path:text-is('${name}'))`;

await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".log-row", { timeout: 30000 });

// Extract z.txt from Mixed work into a new commit after it.
await page.click(row("Mixed work"));
await page.waitForSelector(fileOfCommit("z.txt"));
await page.click(fileOfCommit("z.txt"), { button: "right" });
await menu("Extract Selected Changes to Separate Commit");
await page.waitForSelector(".dialog:has-text('Extract the changes of z.txt')");
await page.fill(".dialog textarea", "Add z");
await page.click(".dialog-buttons button:has-text('Extract')");
await within("the new commit is after Mixed work", async () => git("log", "--format=%s", "-3") === "Top work\nAdd z\nMixed work");
check("Mixed work keeps x and y", filesOf("HEAD~2") === "x.txt,y.txt");
check("the new commit has z", filesOf("HEAD~1") === "z.txt");

// Drop y.txt from Mixed work.
await page.click(row("Mixed work"));
await page.waitForSelector(fileOfCommit("y.txt"));
await page.click(fileOfCommit("y.txt"), { button: "right" });
await menu("Drop Selected Changes");
await page.click(".dialog-buttons button:has-text('Drop')");
await within("Mixed work keeps only x", async () => filesOf("HEAD~2") === "x.txt");
check("y.txt is gone from the working tree too", !git("ls-files", "y.txt"));
await page.click(".toast:has-text('Dropped the changes') button:has-text('Undo')");
await within("Undo puts the change of y back", async () => filesOf("HEAD~2") === "x.txt,y.txt");

// Fixup…: the message gets "fixup! Mixed work". The commit then joins Mixed work with autosquash.
await page.click(row("Mixed work"), { button: "right" });
await menu("Fixup…");
await within("the Changes tab has the fixup message", async () => (await page.inputValue(".commit-message")) === "fixup! Mixed work");
// The log ignores ref changes for 1.5 seconds after an operation of the app (Undo above).
await page.waitForTimeout(2000);
writeFileSync(`${repo}/x.txt`, "x fixed\n");
git("commit", "-q", "-am", "fixup! Mixed work");
await within("the fixup commit shows in the log", async () => (await page.$$eval(".log-row .subject-text", (els) => els.map((e) => e.textContent))).includes("fixup! Mixed work"));
// The rebase starts at Mixed work: the commits below it are on origin/main, a protected branch.
await page.click(row("Mixed work"), { button: "right" });
await menu("Interactively Rebase from Here");
await page.waitForSelector(".rebase-row");
check("the dialog says that it autosquashed", ((await page.textContent(".dialog")) ?? "").includes("Autosquash: 1"));
const order = await page.$$eval(".rebase-row", (els) => els.map((e) => `${e.querySelector("select").value} ${e.querySelector(".rebase-subject").textContent}`));
check("the fixup is right above Mixed work", JSON.stringify(order) === JSON.stringify(["pick Top work", "pick Add z", "fixup fixup! Mixed work", "pick Mixed work"]));
await shot("he1-autosquash");
await page.click(".dialog-buttons button:has-text('Start Rebasing')");
await within("the fixup joined Mixed work", async () => git("log", "--format=%s", "-3") === "Top work\nAdd z\nMixed work");
check("Mixed work has the fixed x", git("show", "HEAD~2:x.txt") === "x fixed");

// Push All up to Here: only the commits up to Mixed work go to origin/main.
await page.click(row("Mixed work"), { button: "right" });
await menu("Push All up to Here");
await page.waitForSelector(".dialog:has-text('Push Commits up to')");
check("the push lists only Mixed work", (await page.$$(".push-commit")).length === 1);
await shot("he2-push-up-to");
await page.click(".dialog-buttons button:has-text('Push')");
const mixed = git("rev-parse", "HEAD~2");
await within("origin/main is at Mixed work", async () => git("--git-dir", `${repo}-origin/.git`, "rev-parse", "main") === mixed);

// The Rebase dialog shows its options. Fixup… showed the Changes tab.
await page.click(".lp-tab:text-is('Branches')");
await page.click(".group-header:has-text('Local') ~ .branch:has-text('fix/readme') >> nth=0", { button: "right" });
await menu("Rebase main onto fix/readme");
await page.waitForSelector(".dialog:has-text('Rebase main onto fix/readme')");
const text = (await page.textContent(".dialog")) ?? "";
check("the Rebase dialog has the options", ["--onto", "--update-refs", "--rebase-merges", "--keep-empty", "--autosquash"].every((o) => text.includes(o)));
await shot("he3-rebase-dialog");
await page.click(".dialog-buttons button:has-text('Cancel')");
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
