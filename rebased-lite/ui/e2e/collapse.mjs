// UI scenario for linear branch collapse on a large repository, for example git/git.
// Start the dev server first (see README), then: node e2e/collapse.mjs <repo> <screenshot-dir>
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
const [,, repo, outDir] = process.argv;
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e));
await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".log-row", { timeout: 60000 });
await page.waitForTimeout(1500);
const count = async () => (await page.textContent(".statusbar")).replace(/\s+/g, " ");
console.log("before:", await count());
await page.screenshot({ path: `${outDir}/c1-expanded.png` });
let t = Date.now();
await page.click(".graph-tools button[title^='Collapse']");
await page.waitForFunction(() => !document.querySelector(".graph-tools button[title^='Expand']").disabled);
await page.waitForTimeout(800);
console.log("collapse ms:", Date.now() - t, "|", await count());
await page.screenshot({ path: `${outDir}/c2-collapsed.png` });
// find a canvas with pointer cursor (collapsed edge) and click it
const box = await page.evaluate(() => {
  const c = [...document.querySelectorAll(".log-row canvas")].find((c) => { const r = c.getBoundingClientRect(); return c.style.cursor === "pointer" && r.y > 150 && r.y < 600; });
  if (!c) return null;
  const r = c.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, row: c.parentElement.dataset.row };
});
console.log("fold at", JSON.stringify(box));
if (box) {
  // try each lane until row count changes
  const before = await count();
  for (let x = 7; x < box.w; x += 15) {
    await page.mouse.click(box.x + x, box.y + box.h / 2);
    await page.waitForTimeout(700);
    if ((await count()) !== before) break;
  }
  console.log("after expand:", await count());
  await page.screenshot({ path: `${outDir}/c3-edge-expanded.png` });
}
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
