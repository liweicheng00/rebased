// UI scenario for Settings › Global Ignore: add a common pattern, save the file, check a path, add a file
// from the Changes tab, and refuse a save over a change from outside.
// The scenario starts its own dev server on port 5175 with a new HOME, so the global ignore file of the
// user stays as it is. Build the dev server and the UI first (see README). Build a fresh repository with
// make-demo-repo.sh, then: node e2e/global-ignore.mjs <repo> <screenshot-dir>.
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const [,, repo, outDir] = process.argv;
if (!repo || !outDir) throw new Error("usage: node e2e/global-ignore.mjs <repo> <screenshot-dir>");
const top = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const home = `${repo}-home`;
rmSync(home, { recursive: true, force: true });
mkdirSync(home, { recursive: true });
const ignoreFile = join(home, ".config", "git", "ignore");
// Files that an editor and Finder make.
mkdirSync(join(repo, ".idea"), { recursive: true });
writeFileSync(join(repo, ".idea", "workspace.xml"), "x");
writeFileSync(join(repo, ".DS_Store"), "x");

const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1", REBASED_LITE_CONFIG_DIR: join(home, "rebased") };
delete env.XDG_CONFIG_HOME;
const server = spawn(join(top, "target", "debug", "rebased-devserver"), [join(top, "ui", "dist"), "5175"], { env, stdio: "ignore" });
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e));
// The save over a change from outside fails on purpose.
page.on("console", (m) => m.type() === "error" && !m.text().includes("status of 400") && errors.push("console: " + m.text()));
const shot = async (name) => { await page.waitForTimeout(500); await page.screenshot({ path: `${outDir}/${name}.png` }); console.log("shot", name); };
const check = (what, ok) => { console.log(ok ? "ok  " : "FAIL", what); if (!ok) errors.push("check: " + what); };
const within = async (what, fn, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return check(what, true);
    await page.waitForTimeout(200);
  }
  check(what, false);
};
const text = async (sel) => ((await page.textContent(sel).catch(() => "")) ?? "").replace(/\s+/g, " ");
const status = () => text(".settings-content .dialog-field-row .settings-hint");
const unversioned = () => page.$$eval(".cl-file .path", (els) => els.map((e) => e.textContent));
const openIgnorePage = async () => {
  await page.click(".tb-button[title='Settings']");
  await page.waitForSelector(".settings-dialog");
  await page.click(".settings-page:has-text('Global Ignore')");
  await page.waitForSelector(".ignore-text:not([disabled])");
};

try {
  for (let i = 0; ; i++) {
    try {
      await page.goto(`http://127.0.0.1:5175/?repo=${encodeURIComponent(repo)}`);
      break;
    } catch (e) {
      if (i > 50) throw e;
      await page.waitForTimeout(200);
    }
  }
  await page.waitForSelector(".log-row", { timeout: 30000 });
  await page.keyboard.press("Control+2");
  await within("the Changes tab shows the files of the editor", async () => (await unversioned()).some((p) => p === "workspace.xml") && (await unversioned()).includes(".DS_Store"));

  // The default file, before it exists. A chip adds its pattern; the text is then not saved.
  await openIgnorePage();
  check("the page names the default file", (await text(".ignore-path")).includes(ignoreFile) && (await text(".ignore-path")).includes("The default file of git"));
  check("the page says that the file does not exist yet", (await status()).includes("does not exist yet"));
  await page.click(".ignore-chip:has-text('.idea/')");
  check("the chip adds its line", (await page.inputValue(".ignore-text")) === ".idea/\n");
  check("the chip shows that the line is there", (await page.$(".ignore-chip.on:has-text('.idea/')")) !== null);
  check("the text is not saved", (await status()) === "Not saved");
  await page.fill(".ignore-check-path", ".idea/workspace.xml");
  await page.click(".settings-content button:has-text('Check')");
  await within("a check asks for a save first", async () => (await text(".ignore-check-result")).includes("Save the file first"));

  // Save makes the file. The check then names the pattern, the file and the line.
  await page.click(".settings-content button:text-is('Save')");
  await within("Save makes the file", async () => existsSync(ignoreFile) && readFileSync(ignoreFile, "utf8") === ".idea/\n");
  await page.click(".settings-content button:has-text('Check')");
  await within("the check names the pattern", async () => (await text(".ignore-check-result")).includes(`Git ignores .idea/workspace.xml: .idea/ (${ignoreFile}, line 1)`));
  await page.fill(".ignore-check-path", "src/main.rs");
  await page.press(".ignore-check-path", "Enter");
  await within("a path without a pattern", async () => (await text(".ignore-check-result")).includes("No pattern matches"));
  await page.fill(".ignore-check-path", ".idea/workspace.xml");
  await page.press(".ignore-check-path", "Enter");
  await shot("gi1-saved-and-checked");
  await page.click(".dialog-buttons button:has-text('OK')");
  await within("the Changes tab no longer shows .idea", async () => !(await unversioned()).some((p) => p === "workspace.xml"));

  // A file of the Changes tab: the menu opens the page with its name added. OK saves it.
  await page.click(".cl-file:has(.path:text-is('.DS_Store'))", { button: "right" });
  await page.click(".menu-item:has-text('Ignore in All Repositories')");
  await page.waitForSelector(".settings-dialog .ignore-text:not([disabled])");
  await within("the page opens with the name added", async () => (await page.inputValue(".ignore-text")) === ".idea/\n.DS_Store\n" && (await status()) === "Not saved");
  await shot("gi2-from-changes");
  await page.click(".dialog-buttons button:has-text('OK')");
  await within("OK saves the file", async () => readFileSync(ignoreFile, "utf8") === ".idea/\n.DS_Store\n");
  await within("the Changes tab no longer shows .DS_Store", async () => !(await unversioned()).includes(".DS_Store"));

  // A change from outside: Save refuses, OK keeps the dialog open, and Reload reads the new text.
  await openIgnorePage();
  await page.fill(".ignore-text", ".idea/\n.DS_Store\n*.swp\n");
  writeFileSync(ignoreFile, ".idea/\n.DS_Store\n*.log\n");
  await page.click(".dialog-buttons button:has-text('OK')");
  await within("the save refuses a change from outside", async () => (await status()).includes("changed outside Rebased Lite"));
  check("the dialog stays open", (await page.$(".settings-dialog")) !== null);
  check("the file keeps the change from outside", readFileSync(ignoreFile, "utf8") === ".idea/\n.DS_Store\n*.log\n");
  await shot("gi3-changed-outside");
  await page.click(".settings-content button:has-text('Reload')");
  await within("Reload reads the new text", async () => (await page.inputValue(".ignore-text")) === ".idea/\n.DS_Store\n*.log\n" && (await status()) === "Saved");
  await page.click(".dialog-buttons button:has-text('Cancel')");
} finally {
  console.log("errors:", JSON.stringify(errors));
  await browser.close();
  server.kill();
}
if (errors.length) process.exit(1);
