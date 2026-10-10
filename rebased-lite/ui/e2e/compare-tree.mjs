// UI scenario for two things. First, a drag of unversioned files to a changelist: git adds the files, and
// they go to that changelist. Second, the tree of files in the compare window: folders open and close,
// the next file follows the tree, and the window keeps its column width and the height of the commits.
// Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh, then:
// node e2e/compare-tree.mjs <repo> <screenshot-dir>.
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const [,, repo, outDir] = process.argv;
const git = (...args) => execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
// A branch with files in folders, for the tree.
git("checkout", "-q", "-b", "nested");
for (const f of ["src/app/view.rs", "src/app/model.rs", "src/util/text.rs", "docs/guide.md"]) {
  mkdirSync(`${repo}/${f.slice(0, f.lastIndexOf("/"))}`, { recursive: true });
  writeFileSync(`${repo}/${f}`, `// ${f}\n`);
}
git("add", "src", "docs");
git("commit", "-q", "-m", "Add nested files");
git("checkout", "-q", "main");
// Unversioned files and a change for the Changes tab.
appendFileSync(`${repo}/README.md`, "\n// changed\n");
writeFileSync(`${repo}/draft.txt`, "draft\n");

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
const tree = async () => ((await page.textContent(".commit-tree")) ?? "").replace(/\s+/g, " ");
const file = (name) => `.cl-file:has(.path:text-is('${name}'))`;

await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".log-row", { timeout: 30000 });
await page.keyboard.press("Control+2");
await page.waitForSelector(file("draft.txt"));

// A second changelist.
await page.click(file("README.md"), { button: "right" });
await page.click(".menu-item:has-text('New Changelist')");
await page.fill(".dialog-field:has-text('Name') input", "Other");
await page.click(".dialog-buttons button:has-text('Create')");
await within("Other holds README.md", async () => /Other ?1 file/.test(await tree()));

// Two unversioned files go to Other with one drag.
await page.click(file("draft.txt"));
await page.click(file("NOTES.txt"), { modifiers: ["Control"] });
await page.dragAndDrop(file("NOTES.txt"), ".cl-header:has-text('Other')");
await within("the drag adds the files to Other", async () => /Other ?3 files/.test(await tree()) && !(await tree()).includes("Unversioned"));
check("git added the files", git("status", "--porcelain", "--", "draft.txt", "NOTES.txt").split("\n").every((l) => l.startsWith("A ")));
await shot("ct1-unversioned-dragged");

// The compare window of main and nested shows a tree.
const openCompare = async () => {
  await page.click(".lp-tab:text-is('Branches')");
  await page.click(".group-header:has-text('Local') ~ .branch:has-text('nested') >> nth=0", { button: "right" });
  await page.click(".menu-item:has-text('Compare Branches: main and nested')");
  await page.waitForSelector(".compare-file");
};
const rows = () => page.$$eval(".compare-files .history-row", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
const selectedFile = () => page.$eval(".compare-file.selected", (e) => e.title).catch(() => "");
await openCompare();
await within("the files show as a tree", async () => {
  const r = await rows();
  return r[0]?.startsWith("docs") && r.some((x) => x.startsWith("src")) && r.some((x) => x.startsWith("app")) && r.some((x) => x.startsWith("view.rs"));
});
check("the first file of the tree shows", (await selectedFile()) === "docs/guide.md");
await shot("ct2-compare-tree");

// A closed folder hides its files. The next file opens it again.
await page.click(".compare-dir:has(.dir-name:text-is('src'))");
await within("the closed folder hides its files", async () => !(await rows()).some((x) => x.startsWith("view.rs")));
await page.click(".compare-file:has-text('guide.md')");
await page.focus(".compare-files");
await page.keyboard.press("ArrowDown");
await within("the next file is the first file in src, and its folder opens", async () => (await selectedFile()) === "src/app/model.rs" && (await rows()).some((x) => x.startsWith("view.rs")));

// The flat list.
await page.click(".compare-tree-toggle");
await within("the flat list shows folders in the rows", async () => !(await page.$(".compare-dir")) && (await rows()).some((x) => x.includes("src/app")));
check("the selected file stays", (await selectedFile()) === "src/app/model.rs");
await page.click(".compare-tree-toggle");

// The width of the column and the height of the commits stay after a reload.
const sideWidth = () => page.$eval(".compare-side", (e) => Math.round(e.getBoundingClientRect().width));
const commitsHeight = () => page.$eval(".compare-commits", (e) => Math.round(e.getBoundingClientRect().height));
const w0 = await sideWidth();
const grip = await page.$eval(".history-body > .vgrip", (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 200 }; });
await page.mouse.move(grip.x, grip.y);
await page.mouse.down();
await page.mouse.move(grip.x + 150, grip.y, { steps: 5 });
await page.mouse.up();
const w1 = await sideWidth();
check("the drag makes the column wider", w1 > w0 + 100);
const g = await page.$eval(".compare-side .column-grip", (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 2 }; });
await page.mouse.move(g.x, g.y);
await page.mouse.down();
await page.mouse.move(g.x, g.y - 100, { steps: 5 });
await page.mouse.up();
const h1 = await commitsHeight();
await page.keyboard.press("Escape");
await page.reload();
await page.waitForSelector(".log-row", { timeout: 30000 });
await openCompare();
await within("the column keeps its width after a reload", async () => Math.abs((await sideWidth()) - w1) <= 1);
await within("the commits keep their height after a reload", async () => Math.abs((await commitsHeight()) - h1) <= 1);
await within("the tree stays", async () => (await page.$(".compare-dir")) !== null);
await shot("ct3-compare-after-reload");
console.log("errors:", JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
