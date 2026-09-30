// UI scenario for remotes: add, fetch, rename and remove a remote, push and delete a tag on it, and set
// and stop the tracked branch of a local branch.
// Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh, then:
// node e2e/remotes.mjs <repo> <screenshot-dir>. The scenario makes a bare repository next to it.
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
const [,, repo, outDir] = process.argv;
const run = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).replace(/\s+$/, "");
const git = (...args) => run(repo, ...args);
const backup = `${repo}-backup.git`;
rmSync(backup, { recursive: true, force: true });
execFileSync("git", ["clone", "-q", "--bare", `${repo}-origin`, backup]);

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e));
page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));
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
const sidebarText = () => page.textContent(".sidebar-list");
// The dialog on top: a form can open over the Remotes dialog.
const top = ".overlay >> nth=-1";

await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".sidebar .branch", { timeout: 30000 });

// Add a remote from the Remotes dialog, and fetch it.
await page.click(".tb-button:has-text('Fetch')");
await page.click(".menu-item:has-text('Manage Remotes')");
await page.waitForSelector(".remote-row:has-text('origin')");
await page.click(".dialog-buttons button:has-text('Add Remote')");
await page.fill(`${top} >> .dialog-field:has-text('Name') input`, "backup");
await page.fill(`${top} >> .dialog-field:has-text('URL') input`, backup);
await page.click(`${top} >> .dialog-buttons button.primary`);
await within("the dialog lists the new remote", async () => (await page.$(".remote-row:has-text('backup')")) !== null);
await within("the fetched branches of the new remote show", async () => (await sidebarText()).includes("Remote: backup"));
await shot("rem1-remotes-dialog");

// Rename it with Edit.
await page.click(".remote-row:has-text('backup') button:has-text('Edit')");
await page.fill(`${top} >> .dialog-field:has-text('Name') input`, "mirror");
await page.click(`${top} >> .dialog-buttons button:has-text('Save')`);
await within("the remote is renamed", async () => (await page.$(".remote-row:has-text('mirror')")) !== null);
await page.click(".dialog-buttons button:has-text('Close')");
await within("the sidebar shows the new name", async () => (await sidebarText()).includes("Remote: mirror"));

// Push a tag to the remote, then delete it there.
await page.click(".group-header:has-text('Tags')");
await page.click(".branch:has-text('v0.2.0')", { button: "right" });
await page.click(".menu-item:has-text('Push Tag to mirror')");
await within("the tag is on the remote", async () => run(backup, "tag", "-l", "v0.2.0") === "v0.2.0");
await page.click(".branch:has-text('v0.2.0')", { button: "right" });
await page.click(".menu-item:has-text('Delete Tag from mirror')");
await page.click(".dialog-buttons button:has-text('Delete')");
await within("the tag is gone from the remote", async () => run(backup, "tag", "-l", "v0.2.0") === "");
check("the local tag stays", git("tag", "-l", "v0.2.0") === "v0.2.0");

// Set the tracked branch of a local branch, then stop tracking.
const local = ".group-header:has-text('Local') ~ .branch:has-text('topic/readme') >> nth=0";
await page.click(local, { button: "right" });
await page.click(".menu-item:has-text('Set Tracked Branch')");
await page.selectOption(".dialog select", "mirror/main");
await page.click(".dialog-buttons button:has-text('Set')");
await within("the branch tracks mirror/main", async () => {
  try {
    return git("rev-parse", "--abbrev-ref", "topic/readme@{upstream}") === "mirror/main";
  } catch {
    return false;
  }
});
await page.click(local, { button: "right" });
await page.click(".menu-item:has-text('Stop Tracking')");
await within("the branch tracks nothing", async () => {
  try {
    git("rev-parse", "--abbrev-ref", "topic/readme@{upstream}");
    return false;
  } catch {
    return true;
  }
});

// Fetch one remote from the Fetch menu.
await page.click(".tb-button:has-text('Fetch')");
await within("the Fetch menu lists each remote", async () => (await page.$(".menu-item:has-text('Fetch mirror')")) !== null);
await page.click(".menu-item:has-text('Fetch origin')");
await within("fetch of one remote finishes", async () => (await page.textContent(".sb-right")).includes("Fetched origin"));

// Remove the remote from its group menu.
await page.click(".group-header:has-text('Remote: mirror')", { button: "right" });
await page.click(".menu-item:has-text('Remove Remote')");
await page.click(".dialog-buttons button:has-text('Remove')");
await within("the remote is removed", async () => !(await sidebarText()).includes("Remote: mirror"));
check("git has no remote mirror", !git("remote").split("\n").includes("mirror"));
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
