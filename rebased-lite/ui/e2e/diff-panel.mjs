// UI scenario for the diff panel: hide it with Esc and the close button, show it with the View menu and a
// double click, and keep its size. It also checks that the HEAD row of the sidebar goes to HEAD, and
// that a double click on a ref label shows only that ref.
// Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh, then:
// node e2e/diff-panel.mjs <repo> <screenshot-dir>.
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
const [,, repo, outDir] = process.argv;

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
const diffHeight = () => page.$eval(".workspace > .diff", (e) => (e.hidden ? 0 : e.getBoundingClientRect().height));
const logHeight = () => page.$eval(".workspace > .top", (e) => e.getBoundingClientRect().height);

await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".log-row", { timeout: 30000 });
await page.click(".log-row >> nth=3");
await page.waitForSelector(".changes-panel .change");

// Drag the splitter to make the diff panel taller.
const before = await diffHeight();
const grip = await page.$eval(".workspace > .diff", (e) => e.getBoundingClientRect().top - 3);
await page.mouse.move(800, grip);
await page.mouse.down();
await page.mouse.move(800, grip - 150, { steps: 5 });
await page.mouse.up();
const tall = await diffHeight();
check("the drag makes the panel taller", tall > before + 100);

const showByMenu = async () => {
  await page.click(".tb-button:has-text('View')");
  await page.click(".menu-item:has-text('Diff Panel')");
};

// Esc hides the panel, and the log takes the space.
await page.click(".log-row >> nth=2");
await page.keyboard.press("Escape");
await within("Esc hides the panel", async () => (await diffHeight()) === 0);
check("the log takes the space", (await logHeight()) > 800);
await shot("dp1-hidden");

// The View menu shows it again with the same size.
await showByMenu();
await within("the View menu shows the panel with its size", async () => Math.abs((await diffHeight()) - tall) < 3);

// Esc that closes a menu, or Esc in a text field, does not hide the panel.
await page.click(".log-row >> nth=2", { button: "right" });
await page.waitForSelector(".menu");
await page.keyboard.press("Escape");
await within("Esc closes the menu", async () => !(await page.$(".menu")));
check("and the panel stays", (await diffHeight()) > 0);
await page.click(".filter-text");
await page.keyboard.press("Escape");
check("Esc in the filter field keeps the panel", (await diffHeight()) > 0);

// The close button.
await page.click(".diff-toolbar button[title='Hide the diff panel']");
await within("the close button hides the panel", async () => (await diffHeight()) === 0);

// A double click on a changed file shows a hidden panel.
await page.dblclick(".changes-panel .change >> nth=0");
await within("a double click shows the panel", async () => (await diffHeight()) > 0);

// The state and the size stay after a reload.
await page.click(".log-row >> nth=2");
await page.keyboard.press("Escape");
await within("hidden again", async () => (await diffHeight()) === 0);
await page.reload();
await page.waitForSelector(".log-row", { timeout: 30000 });
await within("the panel stays hidden after a reload", async () => (await diffHeight()) === 0);
await page.click(".log-row >> nth=2");
await showByMenu();
await within("the size stays after a reload", async () => Math.abs((await diffHeight()) - tall) < 3);

// With one project open, Mod+` shows the Open menu with the recent projects.
await page.keyboard.press("Control+Backquote");
await within("Mod+` opens the Open menu", async () => ((await page.textContent(".menu").catch(() => "")) ?? "").includes("Clone Repository"));
await shot("dp2-open-menu");
await page.keyboard.press("Escape");
await shot("dp2-shown");

// A click on the HEAD row of the sidebar selects the commit of HEAD.
const headSubject = execFileSync("git", ["-C", repo, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim();
await page.click(".log-row >> nth=5");
await page.click(".sidebar-head");
await within("the HEAD row goes to the commit of HEAD", async () => ((await page.textContent(".log-row.selected").catch(() => "")) ?? "").includes(headSubject));

// The arrow keys move the selection after a click on a row.
const rowText = (n) => page.textContent(`.log-row >> nth=${n}`);
await page.click(".log-row >> nth=2");
await page.waitForTimeout(800);
await page.keyboard.press("ArrowDown");
await within("ArrowDown selects the next commit", async () => (await page.textContent(".log-row.selected").catch(() => "")) === (await rowText(3)));
await page.keyboard.press("ArrowUp");
await page.keyboard.press("ArrowUp");
await within("ArrowUp goes back up", async () => (await page.textContent(".log-row.selected").catch(() => "")) === (await rowText(1)));

// A double click on a ref label of a row shows only that ref in the log; a second one shows all refs.
const branchFilter = async () => ((await page.textContent(".filter-bar .filter-label").catch(() => "")) ?? "").trim();
const rows = () => page.$$eval(".log-row", (e) => e.length);
const selectedText = async () => (await page.textContent(".log-row.selected").catch(() => "")) ?? "";
const all = await rows();
// A click on a label copies its name and selects its row.
await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
await page.click(".log-row .ref:text-is('fix/readme')");
await within("a click copies the name", async () => (await page.evaluate(() => navigator.clipboard.readText())) === "fix/readme");
check("the status bar says so", ((await page.textContent(".sb-activity")) ?? "") === "Copied fix/readme");
await within("a hint next to the mouse shows the copy", async () => ((await page.textContent(".copy-hint").catch(() => "")) ?? "").includes("fix/readme"));
check("the hint is next to the mouse", !(await page.$eval(".copy-hint", (e) => e.classList.contains("bottom"))));
await shot("dp5-copy-hint");
await within("the hint goes away", async () => (await page.$(".copy-hint")) === null, 3000);
// A copy with a key shows the hint at the bottom.
await page.waitForTimeout(1600);
await page.keyboard.press("Control+c");
await within("a copy with a key shows the hint at the bottom", async () => !!(await page.$(".copy-hint.bottom")));
await within("the click selects the row", async () => (await selectedText()).includes("Document the build"));
await page.dblclick(".log-row .ref:text-is('fix/readme')");
await within("the filter shows only fix/readme", async () => (await branchFilter()).includes("fix/readme"));
await within("the log has fewer rows", async () => (await rows()) < all);
await within("the row of the label is selected", async () => (await selectedText()).includes("Document the build"));
await shot("dp3-only-ref");
await page.dblclick(".log-row .ref:text-is('fix/readme')");
await within("a second double click shows all refs", async () => (await branchFilter()).includes("All") && (await rows()) === all);
await page.dblclick(".log-row .ref:text-is('v0.1.0')");
await within("a tag label works too", async () => (await branchFilter()).includes("v0.1.0") && (await selectedText()).includes("Add math module"));
check("the Branch button shows its clear icon", await page.isVisible(".filter-bar .filter-x"));
await shot("dp4-filter-x");
await page.click(".filter-bar .filter-x");
await within("the clear icon shows all branches again", async () => (await branchFilter()) === "Branch: All" && (await rows()) === all);
check("the clear icon hides without a branch filter", !(await page.isVisible(".filter-bar .filter-x")));
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
