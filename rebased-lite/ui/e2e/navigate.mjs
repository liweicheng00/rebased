// UI scenario for Back and Forward: the mouse buttons Back and Forward and the keys go through the files
// that the user looked at: files of commits in the log, a local change, and the files of the compare
// window. Back closes the window when the place before is in the main window, and opens it again.
// Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh, then:
// node e2e/navigate.mjs <repo> <screenshot-dir>.
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
/** The mouse button Back (3) or Forward (4); Playwright clicks only the first three buttons. */
const mouse = (button) =>
  page.evaluate((b) => {
    for (const type of ["mousedown", "mouseup"]) window.dispatchEvent(new MouseEvent(type, { button: b, bubbles: true, cancelable: true }));
  }, button);
const diffTitle = async () => ((await page.$$eval(".diff-title", (els) => els.map((e) => (e.offsetParent ? e.textContent.trim() : "")).filter(Boolean).pop() ?? "")));
const selectedRow = async () => ((await page.textContent(".log-row.selected .subject-text").catch(() => "")) ?? "");
const compareOpen = async () => (await page.$(".history-window[aria-label='Compare Branches']")) !== null;
const compareFile = async () => ((await page.$eval(".compare-file.selected", (e) => e.title).catch(() => "")) ?? "");

await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".log-row", { timeout: 30000 });

// Three places in the log: math.rs of "Add math module", then the two files of "Initial commit".
await page.click(".log-row:has-text('Add math module')");
await within("math.rs shows", async () => (await diffTitle()).includes("math.rs"));
await page.click(".log-row:has-text('Initial commit')");
await page.waitForSelector(".changes-panel .change >> nth=1");
await page.click(".changes-panel .change:has(.path:text-is('main.rs'))");
await within("main.rs of the initial commit shows", async () => (await diffTitle()).includes("main.rs"));

// Two places in the compare window.
await page.click(".group-header:has-text('Local') ~ .branch:has-text('feature/cli') >> nth=0", { button: "right" });
await page.waitForTimeout(400);
await page.click(".menu-item:has-text('Compare Branches: main and feature/cli')");
await page.waitForSelector(".compare-file");
const first = await compareFile();
await page.click(".compare-file >> nth=-1");
const second = await compareFile();
check("the compare window has two files", first !== "" && second !== "" && first !== second);

// Back in the window, then out of it, into the log. In the same window, only the file changes: the
// window is the same element, with its list and its scroll position.
await page.$eval(".history-window[aria-label='Compare Branches']", (w) => (w.dataset.mark = "kept"));
await mouse(3);
await within("Back shows the first file of the compare window", async () => (await compareOpen()) && (await compareFile()) === first);
check("the window stays the same, without a new render", (await page.$(".history-window[data-mark='kept']")) !== null);
await mouse(3);
await within("Back closes the window and shows main.rs of the initial commit", async () => !(await compareOpen()) && (await selectedRow()) === "Initial commit" && (await diffTitle()).includes("main.rs"));
await page.keyboard.press("Control+Alt+ArrowLeft");
await within("the key Back goes to the file before", async () => (await selectedRow()) === "Initial commit" && !(await diffTitle()).includes("main.rs"));
await mouse(3);
await within("Back selects Add math module again", async () => (await selectedRow()) === "Add math module" && (await diffTitle()).includes("math.rs"));
await shot("nv1-back");

// Forward goes the same way back, into the window again.
await mouse(4);
await mouse(4);
await within("Forward shows main.rs of the initial commit", async () => (await selectedRow()) === "Initial commit" && (await diffTitle()).includes("main.rs"));
await page.keyboard.press("Control+Alt+ArrowRight");
await within("Forward opens the compare window again", async () => (await compareOpen()) && (await compareFile()) === first);
await page.$eval(".history-window[aria-label='Compare Branches']", (w) => (w.dataset.mark = "again"));
await mouse(4);
await within("Forward shows the second file of the window", async () => (await compareFile()) === second);
check("Forward in the window keeps the window too", (await page.$(".history-window[data-mark='again']")) !== null);
await shot("nv2-forward");
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
