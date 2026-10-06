// UI scenario for Clone Repository: clone a local repository from the Open menu into a folder, open the
// clone in a new tab, and show the error of a bad URL.
// Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh, then:
// node e2e/clone.mjs <repo> <screenshot-dir>. The scenario clones <repo> into <repo>-clones.
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
import { existsSync, mkdirSync, rmSync } from "node:fs";
const [,, repo, outDir] = process.argv;
if (!repo || !outDir) throw new Error("usage: node e2e/clone.mjs <repo> <screenshot-dir>");
const parent = `${repo}-clones`;
rmSync(parent, { recursive: true, force: true });
mkdirSync(parent, { recursive: true });
const name = repo.split("/").pop();

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e));
// The bad URL below fails on purpose.
page.on("console", (m) => m.type() === "error" && !m.text().includes("status of 400") && errors.push("console: " + m.text()));
const shot = async (n) => { await page.waitForTimeout(500); await page.screenshot({ path: `${outDir}/${n}.png` }); console.log("shot", n); };
const check = (what, ok) => { console.log(ok ? "ok  " : "FAIL", what); if (!ok) errors.push("check: " + what); };
const within = async (what, fn, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return check(what, true);
    await page.waitForTimeout(200);
  }
  check(what, false);
};
const folderField = ".dialog-field:has-text('Into the folder') input";
const openClone = async () => {
  await page.click(".tb-button:has-text('Open')");
  await page.click(".menu-item:has-text('Clone Repository')");
  await page.waitForSelector(".dialog:has-text('Clone Repository')");
};

await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".log-row", { timeout: 30000 });

await openClone();
check("the folder starts at the folder of a recent repository", (await page.inputValue(folderField)) !== "");
await page.fill(".dialog-field:has-text('URL') input", repo);
await page.fill(folderField, parent);
await shot("cl1-dialog");
await page.click(".dialog-buttons button:has-text('Clone')");
await within("the clone is on disk, with the name of the URL", async () => existsSync(`${parent}/${name}/.git`));
await within("the clone opens in a new tab", async () => ((await page.textContent(".tab.on").catch(() => "")) ?? "").includes(name) && (await page.$$(".tab")).length === 2);
await within("the log of the clone shows", async () => (await page.$$(".log-row")).length > 0);
await shot("cl2-cloned");

// The dialog remembers the folder. A bad URL shows the error of git.
await openClone();
check("the dialog remembers the folder", (await page.inputValue(folderField)) === parent);
await page.fill(".dialog-field:has-text('URL') input", `${repo}-missing`);
await page.click(".dialog-buttons button:has-text('Clone')");
await within("a bad URL shows the error", async () => ((await page.textContent(".toasts").catch(() => "")) ?? "").includes("The clone failed"));
check("no folder is left", !existsSync(`${parent}/${name}-missing`));
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
