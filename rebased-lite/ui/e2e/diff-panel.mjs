// UI scenario for the diff panel: hide and show it with the shortcut, the close button, the View menu and
// a double click, and keep its size.
// Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh, then:
// node e2e/diff-panel.mjs <repo> <screenshot-dir>.
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
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

// The shortcut hides the panel, and the log takes the space.
await page.click(".log-row >> nth=2");
await page.keyboard.press("Control+2");
await within("the shortcut hides the panel", async () => (await diffHeight()) === 0);
check("the log takes the space", (await logHeight()) > 800);
await shot("dp1-hidden");

// The shortcut shows it again with the same size.
await page.keyboard.press("Control+2");
await within("the shortcut shows the panel with its size", async () => Math.abs((await diffHeight()) - tall) < 3);

// The close button, then the View menu.
await page.click(".diff-toolbar button[title='Hide the diff panel']");
await within("the close button hides the panel", async () => (await diffHeight()) === 0);
await page.click(".tb-button:has-text('View')");
await page.click(".menu-item:has-text('Diff Panel')");
await within("the View menu shows the panel", async () => (await diffHeight()) > 0);

// A double click on a changed file shows a hidden panel.
await page.keyboard.press("Control+2");
await within("hidden again", async () => (await diffHeight()) === 0);
await page.dblclick(".changes-panel .change >> nth=0");
await within("a double click shows the panel", async () => (await diffHeight()) > 0);

// The state and the size stay after a reload.
await page.keyboard.press("Control+2");
await page.reload();
await page.waitForSelector(".log-row", { timeout: 30000 });
await within("the panel stays hidden after a reload", async () => (await diffHeight()) === 0);
await page.click(".log-row >> nth=2");
await page.keyboard.press("Control+2");
await within("the size stays after a reload", async () => Math.abs((await diffHeight()) - tall) < 3);
await shot("dp2-shown");
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
