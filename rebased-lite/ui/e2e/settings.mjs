// UI scenario for the Settings dialog: the diff font, the git program, the keymap, and that the
// settings stay after a reload.
// Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh, then:
// node e2e/settings.mjs <repo> <screenshot-dir>.
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
const [,, repo, outDir] = process.argv;
const gitPath = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

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
const openSettings = async () => {
  await page.click(".tb-button[title='Settings']");
  await page.waitForSelector(".settings-dialog");
};
const pageOf = (name) => page.click(`.settings-page:has-text('${name}')`);
const editorFontSize = () => page.$eval(".editor.modified .view-lines", (e) => getComputedStyle(e).fontSize);

await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".log-row", { timeout: 30000 });
await page.click(".log-row >> nth=0");
await page.waitForSelector(".editor.modified .view-line");
await within("the default diff font is 12px", async () => (await editorFontSize()) === "12px");

// Diff font size.
await openSettings();
await pageOf("Diff");
await page.fill(".settings-number", "16");
await page.press(".settings-number", "Tab");

// The git program: a program that is not git fails the test; the real one gives its version.
await pageOf("Git");
await page.fill(".settings-content input[type=text]", "/bin/true");
await page.click(".settings-content button:has-text('Test')");
await within("a program that is not git fails", async () => (await page.textContent(".settings-hint.error").catch(() => "")).includes("not git"));
// The failed test answers with HTTP 400, which the browser logs as an error.
const i400 = errors.findIndex((e) => e.includes("status of 400"));
if (i400 >= 0) errors.splice(i400, 1);
await page.fill(".settings-content input[type=text]", gitPath);
await page.click(".settings-content button:has-text('Test')");
await within("git gives its version", async () => /^git \d/.test(await page.textContent(".settings-hint.ok").catch(() => "")));

// The keymap: Alt+B for the Branches panel, and F7 for Refresh too, which is a conflict.
await pageOf("Keymap");
await page.click(".keymap-row:has-text('Branches Panel') .key-chip");
await page.keyboard.press("Alt+b");
await within("the new key shows", async () => (await page.textContent(".keymap-row:has-text('Branches Panel') .key-chip")).includes("Alt+B"));
await page.click(".keymap-row:has-text('Refresh') .icon-button[title='Add a key']");
await page.keyboard.press("F7");
await within("a key of two actions is marked", async () => (await page.$$(".key-chip.conflict")).length === 2);
await shot("set1-keymap");
await page.click(".keymap-row:has-text('Refresh') .key-chip.conflict");
await page.keyboard.press("Shift+F5");
await within("the conflict is gone", async () => (await page.$$(".key-chip.conflict")).length === 0);
await page.click(".settings-dialog .dialog-buttons button:has-text('OK')");
await within("the diff font changes", async () => (await editorFontSize()) === "16px");

// The new key works, and the old one does not.
const sidebarShown = () => page.$eval(".left-pane, .sidebar", (e) => !e.closest("[hidden]") && e.offsetParent !== null).catch(() => false);
const before = await sidebarShown();
await page.click(".log-row >> nth=1");
await page.keyboard.press("Alt+b");
await within("Alt+B toggles the Branches panel", async () => (await sidebarShown()) !== before);
await page.keyboard.press("Control+1");
await page.waitForTimeout(400);
check("Ctrl+1 does nothing now", (await sidebarShown()) !== before);

// The settings stay after a reload.
await page.reload();
await page.waitForSelector(".log-row", { timeout: 30000 });
await openSettings();
await pageOf("Diff");
check("the font size stays", (await page.inputValue(".settings-number")) === "16");
await pageOf("Git");
check("the git program stays", (await page.inputValue(".settings-content input[type=text]")) === gitPath);
await pageOf("Keymap");
check("the key stays", (await page.textContent(".keymap-row:has-text('Branches Panel') .key-chip")).includes("Alt+B"));
// Reset: the default keys come back.
await page.click(".settings-dialog button:has-text('Reset All Keys')");
check("reset brings Ctrl+1 back", (await page.textContent(".keymap-row:has-text('Branches Panel') .key-chip")).includes("1"));
await page.click(".settings-dialog .dialog-buttons button:has-text('Cancel')");
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
