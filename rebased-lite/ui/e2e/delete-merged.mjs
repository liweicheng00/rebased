// UI scenario for Delete Merged Branches: the preview, a kept branch, Undo, and a bad pattern.
// Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh, then:
// node e2e/delete-merged.mjs <repo> <screenshot-dir>. Set NATIVE=1 when the dev server uses git 2.56 or
// later. Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
const [,, repo, outDir] = process.argv;
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).replace(/\s+$/, "");
const has = (b) => git("branch", "--list", b) !== "";
git("config", "commit.gpgsign", "false");
git("fetch", "-q");
// Two branches whose work is on origin/main, and one with its own commit.
git("branch", "-q", "--track", "done-1", "origin/main");
git("branch", "-q", "--track", "done-2", "origin/main");
git("branch", "-q", "--track", "wip", "origin/main");
git("worktree", "add", "-q", `${repo}-wt`, "wip");
execFileSync("git", ["-C", `${repo}-wt`, "commit", "-q", "--allow-empty", "-m", "Work in progress"]);
git("worktree", "remove", `${repo}-wt`);

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e));
// The bad pattern below fails with a 400 on purpose.
page.on("console", (m) => m.type() === "error" && !m.text().includes("status of 400") && errors.push("console: " + m.text()));
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
const rows = async () => (await page.$$eval(".merged-row .merged-name", (els) => els.map((e) => e.textContent))).sort().join(",");

await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".sidebar .branch", { timeout: 30000 });

// The Local group header has the action.
await page.click(".group-header:has-text('Local')", { button: "right" });
await page.click(".menu-item:has-text('Delete Merged Branches')");
await page.waitForSelector(".dialog:has-text('Delete Merged Branches')");
await within("the preview shows the merged branches only", async () => (await rows()) === "done-1,done-2");
const note = (await page.textContent(".dialog")) ?? "";
check("the note says how git finds them", note.includes(process.env.NATIVE ? "Git finds the branches" : "older than 2.56"));
await page.click(".merged-row:has-text('done-2') input");
await within("the summary counts the chosen branches", async () => ((await page.textContent(".merged-summary")) ?? "").startsWith("1 of 2"));
await shot("dm1-preview");

// Delete: done-2 stays because the user keeps it.
await page.click(".dialog-buttons button:has-text('Delete')");
await within("done-1 is deleted", async () => !has("done-1"));
check("done-2 and wip stay", has("done-2") && has("wip"));
await within("the sidebar drops done-1", async () => !((await page.textContent(".sidebar-list")) ?? "").includes("done-1"));
await shot("dm2-deleted");

// Undo creates the branch again, with its tracked branch.
await page.click(".toast button:has-text('Undo')");
await within("Undo creates done-1 again", async () => has("done-1"));
check("done-1 tracks origin/main again", git("rev-parse", "--abbrev-ref", "done-1@{upstream}") === "origin/main");

// A bad pattern shows the error of git, and Enter in the field only loads the preview again.
await page.click(".group-header:has-text('Local')", { button: "right" });
await page.click(".menu-item:has-text('Delete Merged Branches')");
await page.fill(".merged-patterns", "no-such-branch");
await page.press(".merged-patterns", "Enter");
await within("a bad pattern shows the error", async () => ((await page.textContent(".merged-list")) ?? "").includes("not a valid branch or pattern"));
check("Enter in the pattern field does not delete", has("done-1") && has("done-2"));
await page.fill(".merged-patterns", "origin/main");
await page.press(".merged-patterns", "Enter");
await within("an exact branch works", async () => (await rows()) === "done-1,done-2");
// A branch that becomes merged while the dialog is open stops the delete.
git("branch", "-q", "--track", "done-3", "origin/main");
await page.click(".dialog-buttons button:has-text('Delete')");
await within("a changed list stops the delete", async () => ((await page.textContent(".toasts").catch(() => "")) ?? "").includes("changed since the list was made"));
check("nothing is deleted", has("done-1") && has("done-2") && has("done-3"));
await shot("dm3-changed");

// The list again, then the delete.
await page.click(".group-header:has-text('Local')", { button: "right" });
await page.click(".menu-item:has-text('Delete Merged Branches')");
await page.fill(".merged-patterns", "origin/main");
await page.press(".merged-patterns", "Enter");
await within("the new list has the new branch", async () => (await rows()) === "done-1,done-2,done-3");
await page.click(".dialog-buttons button:has-text('Delete')");
await within("all three are deleted", async () => !has("done-1") && !has("done-2") && !has("done-3"));
check("wip stays", has("wip"));
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
