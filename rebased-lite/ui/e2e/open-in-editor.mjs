// UI scenario for Open in Editor: choose the editor in the settings, then open a file with F4, the button of
// the diff and the file menu, at the line of the cursor. A small script stands in for the editor and writes
// its arguments to a file. A missing program shows an error.
// Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh, then:
// node e2e/open-in-editor.mjs <repo> <screenshot-dir>.
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const [,, repo, outDir] = process.argv;
const script = `${repo}-editor.sh`;
const log = `${repo}-editor.log`;
writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\n`);
chmodSync(script, 0o755);
const opened = () => (existsSync(log) ? readFileSync(log, "utf8").trim() : "");

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e));
// The missing program below fails on purpose.
page.on("console", (m) => m.type() === "error" && !m.text().includes("status of 400") && errors.push("console: " + m.text()));
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
const setEditor = async (command) => {
  await page.click(".tb-button[title='Settings']");
  await page.waitForSelector(".settings-dialog");
  await page.click(".settings-page:has-text('Editor')");
  if (command === null) return;
  await page.fill(".editor-command", command);
  await page.click(".settings-dialog .dialog-buttons button:has-text('OK')");
};
const expectOpened = (what, line) => within(what, async () => opened() === `--goto\n${repo}/main.rs:${line}`);

await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".log-row", { timeout: 30000 });

// The Editor page: a preset fills the command.
await setEditor(null);
await page.selectOption(".editor-preset", { label: "Visual Studio Code" });
check("the preset fills the command", (await page.inputValue(".editor-command")) === "code --goto {file}:{line}:{column}");
await shot("oe1-settings");
await page.fill(".editor-command", `${script} --goto {file}:{line}`);
check("another command shows as Other command", (await page.$eval(".editor-preset", (e) => e.selectedOptions[0].textContent)) === "Other command");
await page.click(".settings-dialog .dialog-buttons button:has-text('OK')");

// F4 in the Changes tab opens the selected file at the first change on the screen. main.rs adds line 4.
await page.keyboard.press("Control+2");
await page.click(".cl-file:has(.path:text-is('main.rs'))");
await page.waitForSelector(".diff .editor.modified .view-line");
await page.waitForTimeout(800);
await page.keyboard.press("F4");
await expectOpened("F4 opens the file at the first change", 4);
check("the status bar says so", ((await page.textContent(".sb-activity")) ?? "").includes("main.rs:4"));

// A click on line 2 of the diff, then the button of the diff toolbar.
rmSync(log, { force: true });
const lineTwo = await page.$$eval(".diff .editor.modified .line-numbers", (els) => {
  const e = els.find((x) => x.textContent?.trim() === "2");
  const r = e?.getBoundingClientRect();
  return r ? { y: r.top + r.height / 2 } : null;
});
const text = await page.$eval(".diff .editor.modified .view-lines", (e) => { const r = e.getBoundingClientRect(); return r.left + 40; });
await page.mouse.click(text, lineTwo.y);
await page.click(".diff .diff-open-editor");
await expectOpened("the button opens the line of the cursor", 2);
// F4 in the diff takes the same line.
rmSync(log, { force: true });
await page.keyboard.press("F4");
await expectOpened("F4 in the diff opens the line of the cursor", 2);

// The file menu.
rmSync(log, { force: true });
await page.click(".cl-file:has(.path:text-is('main.rs'))", { button: "right" });
check("the menu shows the key", ((await page.textContent(".menu-item:has-text('Open in Editor')")) ?? "").includes("F4"));
await shot("oe2-menu");
await page.click(".menu-item:has-text('Open in Editor')");
await within("the menu opens the file", async () => opened().startsWith(`--goto\n${repo}/main.rs:`));

// F4 in the Compare window opens the file of its diff.
rmSync(log, { force: true });
await page.dblclick(".cl-file:has(.path:text-is('main.rs'))");
await page.waitForSelector(".merge-overlay .editor.modified .view-line");
await page.waitForTimeout(800);
await page.keyboard.press("F4");
await within("F4 in the Compare window opens its file", async () => opened().startsWith(`--goto\n${repo}/main.rs:`));
await page.keyboard.press("Escape");
await page.waitForSelector(".merge-overlay", { state: "detached" });

// A program that does not exist shows an error.
await setEditor("no-such-editor-xyz {file}");
await page.click(".cl-file:has(.path:text-is('main.rs'))");
await page.keyboard.press("F4");
await within("a missing program shows an error", async () => ((await page.textContent(".toasts").catch(() => "")) ?? "").includes("Cannot find the editor program no-such-editor-xyz"));
await shot("oe3-error");
await setEditor("");
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
