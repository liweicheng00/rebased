// UI scenario. Start the dev server first (see README), then: node e2e/large-repo.mjs <repo> <screenshot-dir>
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
const [,, repo, outDir] = process.argv;
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e));
page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));
const shot = async (name) => { await page.waitForTimeout(700); await page.screenshot({ path: `${outDir}/${name}.png` }); console.log("shot", name); };
const log = (...a) => console.log(...a);

await page.goto("http://127.0.0.1:5174/");
await page.waitForSelector(".welcome-card");
await shot("01-welcome");

// open through the dialog
await page.click(".welcome-card .primary");
await page.fill(".dialog-input", repo);
await page.click(".dialog .primary");
await page.waitForSelector(".log-row.selected", { timeout: 60000 });
await page.waitForSelector(".change", { timeout: 60000 });
await page.waitForTimeout(1500);
await shot("02-main-head");
log("status:", await page.textContent(".statusbar"));

// two commits
const sel = Number(await page.getAttribute(".log-row.selected", "data-row"));
await page.click(`.log-row[data-row="${sel + 3}"]`);
await page.click(`.log-row[data-row="${sel + 12}"]`, { modifiers: ["Control"] });
await page.waitForTimeout(2500);
await shot("03-two-commits");
log("changes title:", await page.textContent(".changes-title"), await page.textContent(".changes-count"));

// flat list + next file + unified diff
await page.click(".changes-panel .pane-title .icon-button");
await page.keyboard.down("Alt"); await page.keyboard.press("ArrowDown"); await page.keyboard.up("Alt");
await page.uncheck(".diff-option:has-text('Side by side') input");
await page.waitForTimeout(1500);
await shot("04-flat-unified");
await page.check(".diff-option:has-text('Side by side') input");
await page.click(".changes-panel .pane-title .icon-button");

// author filter -> dotted graph
await page.fill(".filter-author", "Patrick Steinhardt");
await page.waitForTimeout(2500);
await page.waitForSelector(".log-row");
await shot("05-filter-author");
log("filter info:", await page.textContent(".filter-info"));

// context menu
await page.locator('.log-row').nth(3).click({ button: "right" });
await shot("06-context-menu");
await page.keyboard.press("Escape");

// clear, branch filter via sidebar
await page.click(".filter-clear");
await page.waitForTimeout(2000);
await page.waitForTimeout(300);
const maint = page.locator(".branch:has-text('maint')").first();
await maint.dblclick();
await page.waitForTimeout(2500);
await shot("07-branch-filter");
log("branch filter:", await page.textContent(".filter-info"), await page.textContent(".filter-bar .filter-button"));
await page.click(".filter-clear");
await page.waitForTimeout(1500);

// hash jump
await page.fill(".filter-text", "e83c5163316f89bfbde7d9ab23ca2e25604af290");
await page.press(".filter-text", "Enter");
await page.waitForTimeout(2500);
await shot("08-jump-first-commit");
log("details:", (await page.textContent(".details-subject")) ?? "");

// view menu + dark theme
await page.click(".toolbar button:has-text('View')");
await shot("09-view-menu");
await page.keyboard.press("Escape");
await page.click(".toolbar button:has-text('◐')");
await page.click(".menu-item:has-text('Dark')");
await page.click('.log-row >> nth=5');
await page.waitForTimeout(2500);
await shot("10-dark");
log("errors:", JSON.stringify(errors));
await browser.close();
