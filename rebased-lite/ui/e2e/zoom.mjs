// UI scenario for the zoom of the window: Zoom In, Zoom Out and Actual Size with the keys and the View
// menu, and the level after a reload. In a browser the dev server zooms the page with CSS; the app zooms
// its webview. Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh,
// then: node e2e/zoom.mjs <repo> <screenshot-dir>.
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
const zoom = () => page.evaluate(() => document.documentElement.style.zoom || "1");
const status = async () => (await page.textContent(".sb-activity")) ?? "";

await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".log-row", { timeout: 30000 });
await page.click(".log-row >> nth=1");

await page.keyboard.press("Control+Equal");
await within("Mod+= zooms in to 110%", async () => (await zoom()) === "1.1" && (await status()) === "Zoom 110%");
await page.keyboard.press("Control+Shift+Equal");
await within("Mod+Shift+= (Mod++) zooms in to 125%", async () => (await zoom()) === "1.25");
await shot("zm1-125");
await page.keyboard.press("Control+Minus");
await page.keyboard.press("Control+Minus");
await page.keyboard.press("Control+Minus");
await within("Mod+- zooms out to 90%", async () => (await zoom()) === "0.9" && (await status()) === "Zoom 90%");

// The level stays after a reload.
await page.reload();
await page.waitForSelector(".log-row", { timeout: 30000 });
await within("the level stays after a reload", async () => (await zoom()) === "0.9");

// The View menu.
await page.click(".tb-button:has-text('View')");
check("the menu shows the level", ((await page.textContent(".menu-item:has-text('Actual Size')")) ?? "").includes("90%"));
await shot("zm2-menu");
await page.click(".menu-item:has-text('Actual Size')");
await within("Actual Size goes back to 100%", async () => (await zoom()) === "1");
await page.keyboard.press("Control+Equal");
await page.keyboard.press("Control+Digit0");
await within("Mod+0 goes back to 100%", async () => (await zoom()) === "1" && (await status()) === "Zoom 100%");
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
