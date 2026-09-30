// UI scenario for credential prompts: Fetch from a remote that needs a user name and a password.
// The scenario serves a bare copy of the demo origin over git's dumb HTTP protocol with Basic authentication.
// Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh, then:
// node e2e/credentials.mjs <repo> <screenshot-dir>. The scenario changes the repository.
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
const [,, repo, outDir] = process.argv;
const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).replace(/\s+$/, "");

// A bare copy of the origin, with a new branch, served with authentication.
const bare = `${repo}-secure.git`;
execFileSync("rm", ["-rf", bare]);
execFileSync("git", ["clone", "-q", "--bare", `${repo}-origin`, bare]);
git(bare, "branch", "only-on-secure", "main");
git(bare, "repack", "-a", "-d", "-q");
git(bare, "update-server-info");
const auth = "Basic " + Buffer.from("ada:s3cret").toString("base64");
let denied = 0;
const server = createServer(async (req, res) => {
  if (req.headers.authorization !== auth) {
    denied++;
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="demo"' });
    return res.end();
  }
  const path = normalize(decodeURIComponent(req.url.split("?")[0])).replace(/^\/secure\.git/, "");
  try {
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    res.end(await readFile(join(bare, path)));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
git(repo, "remote", "add", "secure", `http://127.0.0.1:${port}/secure.git`);

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e));
page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));
const shot = async (name) => { await page.waitForTimeout(500); await page.screenshot({ path: `${outDir}/${name}.png` }); console.log("shot", name); };
const check = (what, ok) => { console.log(ok ? "ok  " : "FAIL", what); if (!ok) errors.push("check: " + what); };

await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".log-row", { timeout: 30000 });
await page.click(".tb-button:has-text('Fetch')");
await page.click(".menu-item:has-text('Fetch All Remotes')");
await page.waitForSelector(".credential-prompt", { timeout: 20000 });
check("git asks for the user name", (await page.textContent(".credential-prompt")).startsWith("Username for 'http://127.0.0.1:"));
await page.fill(".dialog input.dialog-input", "ada");
await page.click(".dialog-buttons button:has-text('OK')");
await page.waitForSelector(".dialog input[type=password]", { timeout: 20000 });
check("git asks for the password", (await page.textContent(".credential-prompt")).startsWith("Password for 'http://ada@127.0.0.1:"));
await page.fill(".dialog input[type=password]", "s3cret");
await page.check(".dialog .dialog-check input");
await shot("cr1-password");
await page.click(".dialog-buttons button:has-text('OK')");
await page.waitForTimeout(3000);
check("the fetch got the branch of the secure remote", git(repo, "branch", "-r").includes("secure/only-on-secure"));
check("the server asked for authentication", denied > 0);
await page.click(".lp-tab:has-text('Branches')");
check("the branch shows in the sidebar", (await page.textContent(".sidebar-list")).includes("only-on-secure"));

// A second fetch asks only for the user name: the password is remembered.
git(bare, "branch", "second-branch", "main");
git(bare, "update-server-info");
await page.click(".tb-button:has-text('Fetch')");
await page.click(".menu-item:has-text('Fetch All Remotes')");
await page.waitForSelector(".credential-prompt", { timeout: 20000 });
await page.fill(".dialog input.dialog-input", "ada");
await page.click(".dialog-buttons button:has-text('OK')");
await page.waitForTimeout(3000);
check("no password prompt the second time", !(await page.$(".dialog input[type=password]")));
check("the second fetch worked", git(repo, "branch", "-r").includes("secure/second-branch"));
await shot("cr2-done");
console.log("errors:", JSON.stringify(errors));
await browser.close();
server.close();
if (errors.length) process.exit(1);
