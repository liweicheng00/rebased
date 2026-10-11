// UI scenario for Show Repository at Revision and for the changes of a merge commit to each parent.
// Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh, then:
// node e2e/repo-at-revision.mjs <repo> <screenshot-dir>.
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
const [,, repo, outDir] = process.argv;
const git = (...args) => execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
// A commit with files in folders, on a side branch.
const blob = (text) => execFileSync("git", ["-C", repo, "hash-object", "-w", "--stdin"], { input: text, encoding: "utf8" }).trim();
const index = `${repo}/.git/tmp-index`;
const env = { ...process.env, GIT_INDEX_FILE: index };
execFileSync("git", ["-C", repo, "read-tree", "main"], { env });
for (const [p, t] of [["src/app/view.rs", "pub fn view() {}\n"], ["src/app/model.rs", "pub struct Model;\n"], ["docs/guide.md", "# Guide\n"]]) {
  execFileSync("git", ["-C", repo, "update-index", "--add", "--cacheinfo", `100644,${blob(t)},${p}`], { env });
}
const tree = execFileSync("git", ["-C", repo, "write-tree"], { env, encoding: "utf8" }).trim();
git("update-ref", "refs/heads/folders", git("commit-tree", tree, "-p", "main", "-m", "Add folders"));

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
const changeNames = () => page.$$eval(".changes-panel .change .path", (els) => els.map((e) => e.textContent.trim()));
const rows = () => page.$$eval(".repo-browser-files .history-row", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));

await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".log-row", { timeout: 30000 });

// A merge commit: the changes to the first parent, then to the second parent.
await page.click(".log-row:has-text(\"Merge branch 'feature/parser'\")");
const merge = git("log", "--format=%H", "-1", "--grep=Merge branch 'feature/parser'", "main");
const first = git("diff", "--name-only", `${merge}^1`, merge).split("\n").filter(Boolean).map((p) => p.split("/").pop()).sort();
const second = git("diff", "--name-only", `${merge}^2`, merge).split("\n").filter(Boolean).map((p) => p.split("/").pop()).sort();
await within("the parent choice shows for a merge commit", async () => (await page.isVisible(".changes-parent-bar")) && (await page.$$(".changes-parent option")).length === 2);
await within("the changes to parent 1 show", async () => JSON.stringify((await changeNames()).sort()) === JSON.stringify(first));
await page.selectOption(".changes-parent", "1");
await within("the changes to parent 2 show", async () => JSON.stringify((await changeNames()).sort()) === JSON.stringify(second));
await shot("rr1-merge-parent");
await page.click(".log-row:has-text('Initial commit')");
await within("a plain commit has no parent choice", async () => !(await page.isVisible(".changes-parent-bar")));

// Show Repository at Revision: the folders are closed at first; a click opens one; a file shows.
await page.click(".log-row:has-text('Add folders')", { button: "right" });
await page.click(".menu-item:has-text('Show Repository at Revision')");
await page.waitForSelector(".repo-browser-files .history-row");
const files = git("ls-tree", "-r", "--name-only", "folders").split("\n").filter(Boolean);
await within("the title counts the files", async () => ((await page.textContent(".merge-header")) ?? "").includes(`${files.length} files`));
await within("the folders are closed at first", async () => {
  const r = await rows();
  return r.some((x) => x.startsWith("docs")) && r.some((x) => x.startsWith("src/app")) && !r.some((x) => x.startsWith("view.rs"));
});
await page.click(".repo-browser-files .compare-dir:has-text('src/app')");
await within("a click opens the joined folders", async () => (await rows()).some((x) => x.startsWith("view.rs")));
await page.click(".repo-browser-row:has-text('view.rs')");
await within("the file shows", async () => ((await page.textContent(".repo-browser-editor .view-lines")) ?? "").replace(/\s/g, "").includes("pubfnview(){}"));
await page.fill(".repo-browser-search", "guide");
await within("the search shows the matching files", async () => {
  const r = await rows();
  return r.length === 1 && r[0].includes("guide.md") && r[0].includes("docs");
});
await shot("rr2-repo-browser");
await page.keyboard.press("Escape");
await within("Esc closes the window", async () => !(await page.$(".repo-browser-files")));
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
