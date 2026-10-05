// UI scenario for many files in the Changes tab: select with Ctrl+click and Shift+click, drag the selection
// to another changelist, and use the menu on the selection. A plain click then selects one file only.
// Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh, then:
// node e2e/changes-multi.mjs <repo> <screenshot-dir>.
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
import { appendFileSync } from "node:fs";
const [,, repo, outDir] = process.argv;
for (const f of ["README.md", "arith.rs", "parser.rs"]) appendFileSync(`${repo}/${f}`, "\n// changed\n");

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
const tree = async () => ((await page.textContent(".commit-tree")) ?? "").replace(/\s+/g, " ");
const selected = () => page.$$eval(".cl-file.selected .path", (els) => els.map((e) => e.textContent).sort().join(","));
const file = (name) => `.cl-file:has(.path:text-is('${name}'))`;

await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".log-row", { timeout: 30000 });
await page.keyboard.press("Control+2");
await page.waitForSelector(file("parser.rs"));

// A second changelist with README.md.
await page.click(file("README.md"), { button: "right" });
await page.click(".menu-item:has-text('New Changelist')");
await page.fill(".dialog-field:has-text('Name') input", "Other");
await page.click(".dialog-buttons button:has-text('Create')");
await within("Other holds README.md", async () => /Other ?1 file/.test(await tree()));

// Ctrl+click selects two files.
await page.click(file("arith.rs"));
await page.click(file("parser.rs"), { modifiers: ["Control"] });
check("two files are selected", (await selected()) === "arith.rs,parser.rs");
await shot("cm1-two-selected");

// A drag of one of them moves both.
await page.dragAndDrop(file("parser.rs"), ".cl-header:has-text('Other')");
await within("the drag moves the two files", async () => /Other ?3 files/.test(await tree()));

// Shift+click selects a range, and the menu acts on all of it.
await page.click(file("README.md"));
await page.click(file("parser.rs"), { modifiers: ["Shift"] });
check("Shift+click selects the range", (await selected()) === "README.md,arith.rs,parser.rs");
await page.click(file("arith.rs"), { button: "right" });
check("the menu keeps the selection", (await selected()) === "README.md,arith.rs,parser.rs");
check("the menu is for many files", (await page.$$(".menu-item:has-text('Copy Paths')")).length === 1);
await shot("cm2-menu");
await page.click(".menu-item:has-text('Changes (active)')");
await within("the menu moves the three files back", async () => /Changes ?4 files/.test(await tree()));

// A plain click on a file of the selection selects that file only.
await page.click(file("arith.rs"));
await page.click(file("main.rs"), { modifiers: ["Control"] });
await page.click(file("main.rs"));
check("a plain click selects one file", (await selected()) === "main.rs");
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
