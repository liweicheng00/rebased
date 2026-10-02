// UI scenario for submodules: the Submodules section, the diff of a submodule, and Update.
// Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh, then:
// node e2e/submodules.mjs <repo> <screenshot-dir>. The scenario adds a submodule to the repository.
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
const [,, repo, outDir] = process.argv;
const run = (dir, ...args) => execFileSync("git", ["-C", dir, "-c", "protocol.file.allow=always", ...args], { encoding: "utf8" }).replace(/\s+$/, "");
const git = (...args) => run(repo, ...args);

// A library repository with two commits, added to the demo repository as a submodule.
const lib = `${repo}-lib`;
rmSync(lib, { recursive: true, force: true });
mkdirSync(lib, { recursive: true });
run(lib, "init", "-q", "-b", "main");
for (const [n, text] of [["One", "pub fn one() {}\n"], ["Two", "pub fn two() {}\n"]]) {
  writeFileSync(`${lib}/lib.rs`, text);
  run(lib, "add", ".");
  run(lib, "-c", "user.name=Lib", "-c", "user.email=lib@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", n);
}
const c1 = run(lib, "rev-parse", "HEAD~1");
const c2 = run(lib, "rev-parse", "HEAD");
git("submodule", "add", "-q", lib, "vendor/lib");
git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "Add the lib submodule");
const sub = `${repo}/vendor/lib`;

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e));
page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));
const shot = async (name) => { await page.waitForTimeout(500); await page.screenshot({ path: `${outDir}/${name}.png` }); console.log("shot", name); };
const check = (what, ok) => { console.log(ok ? "ok  " : "FAIL", what); if (!ok) errors.push("check: " + what); };
const within = async (what, fn, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return check(what, true);
    await page.waitForTimeout(200);
  }
  check(what, false);
};

await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".log-row", { timeout: 30000 });
await page.waitForSelector(".branch.submodule");
check("the Submodules section lists vendor/lib", (await page.textContent(".branch.submodule")).includes("vendor/lib"));

// The submodule at another commit: a local change with a "Subproject commit" diff.
run(sub, "checkout", "-q", c1);
await page.keyboard.press("F5");
await within("the sidebar shows another commit", async () => (await page.textContent(".branch.submodule")).includes("other commit"));
await page.click(".lp-tab:has-text('Changes')");
// The Changes tab groups the files by folder: the submodule shows as "lib" under "vendor".
await within("the submodule is a local change", async () => (await page.$(".cl-file:has-text('lib')")) !== null);
await page.click(".cl-file:has-text('lib')");
await within("the diff shows the two commits", async () => {
  const t = await page.textContent(".diff");
  return t.includes(c1.slice(0, 12)) && t.includes(c2.slice(0, 12)) && t.includes("Submodule");
});
await shot("sm1-submodule-diff");
await page.click(".lp-tab:has-text('Branches')");

// Update to the recorded commit.
await page.click(".branch.submodule", { button: "right" });
await page.click(".menu-item:has-text('Update to the Recorded Commit')");
await within("Update checks out the recorded commit", async () => run(sub, "rev-parse", "HEAD") === c2);
await within("the sidebar shows the submodule as clean", async () => !(await page.textContent(".branch.submodule")).includes("other commit"));

// A checkout that changes the recorded commit offers Update Submodules.
git("checkout", "-q", "-b", "old-lib");
run(sub, "checkout", "-q", c1);
git("-c", "commit.gpgsign=false", "commit", "-q", "-am", "Use the old lib");
git("checkout", "-q", "main");
run(sub, "checkout", "-q", c2);
await page.keyboard.press("F5");
await page.waitForSelector(".branch:has-text('old-lib')");
await page.dblclick(".branch:has-text('old-lib')");
await within("the checkout offers Update Submodules", async () => (await page.$(".toast-action:has-text('Update Submodules')")) !== null);
await shot("sm2-update-offer");
await page.click(".toast-action:has-text('Update Submodules')");
await within("the submodule follows the checkout", async () => run(sub, "rev-parse", "HEAD") === c1);
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
