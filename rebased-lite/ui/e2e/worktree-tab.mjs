// UI scenario for the tab of a linked worktree: it shows the worktree icon and the name of its main
// repository, and its tooltip names the branch. The tab of the main repository stays plain.
// Start the dev server first (see README). Build a fresh repository with make-demo-repo.sh, then:
// node e2e/worktree-tab.mjs <repo> <screenshot-dir>. The scenario makes worktrees next to <repo>.
// Two worktrees with the same folder name show the folders above them: "<repo>-x/app" and "<repo>-y/app".
// Set CHROMIUM to a Chromium binary when Playwright has no downloaded browser.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
const [,, repo, outDir] = process.argv;
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const wt = `${repo}-wt-tab`;
rmSync(wt, { recursive: true, force: true });
git("worktree", "add", "-q", "-b", "wt-tab", wt, "main");
const same = [`${repo}-x/app`, `${repo}-y/app`];
for (const [i, p] of same.entries()) {
  rmSync(p.slice(0, p.lastIndexOf("/")), { recursive: true, force: true });
  git("worktree", "add", "-q", "-b", `same-${i}`, p, "main");
}
const name = repo.split("/").pop();

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e));
const shot = async (n) => { await page.waitForTimeout(500); await page.screenshot({ path: `${outDir}/${n}.png` }); console.log("shot", n); };
const check = (what, ok) => { console.log(ok ? "ok  " : "FAIL", what); if (!ok) errors.push("check: " + what); };
const within = async (what, fn, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return check(what, true);
    await page.waitForTimeout(200);
  }
  check(what, false);
};
const tabs = () => page.$$eval(".tab", (els) => els.map((e) => ({ text: e.textContent.replace(/\s+/g, " ").trim(), worktree: e.classList.contains("worktree"), title: e.title })));

await page.goto(`http://127.0.0.1:5174/?repo=${encodeURIComponent(repo)}`);
await page.waitForSelector(".sidebar .worktree", { timeout: 30000 });
await page.dblclick(`.sidebar .worktree:has(.branch-name:text-is('${wt.split("/").pop()}'))`);
await within("two tabs", async () => (await tabs()).length === 2);
await within("the worktree tab shows its main repository", async () => {
  const t = (await tabs()).find((x) => x.text.startsWith(wt.split("/").pop()));
  return !!t && t.worktree && t.text.includes(`of ${name}`) && t.title.includes(`Worktree of ${repo}`) && t.title.includes("Branch: wt-tab");
});
const main = (await tabs()).find((x) => x.text === name);
check("the tab of the main repository is plain", !!main && !main.worktree && main.title.includes("Branch: main"));
check("the worktree tab has the worktree icon", (await page.$(".tab.worktree .icon-worktree")) !== null);

// The same folder name: the worktree list and the tabs show the folder above.
const short = (p) => p.split("/").slice(-2).join("/");
const listed = await page.$$eval(".sidebar .worktree .branch-name", (els) => els.map((e) => e.textContent));
check("the worktree list shows the folders above the same names", same.every((p) => listed.includes(short(p))));
for (const p of same) await page.dblclick(`.sidebar .worktree:has(.branch-name:text-is('${short(p)}'))`).then(() => page.waitForTimeout(1500));
await within("four tabs", async () => (await tabs()).length === 4);
const texts = (await tabs()).map((t) => t.text);
check("the two tabs with the same name differ", same.every((p) => texts.some((t) => t.startsWith(short(p)))));
check("the toolbar names the repository as its tab does", ((await page.textContent(".tb-repo")) ?? "").trim() === short(same[1]));
await shot("wt1-tabs");
console.log("errors:", JSON.stringify(errors));
await browser.close();
rmSync(wt, { recursive: true, force: true });
for (const p of same) rmSync(p.slice(0, p.lastIndexOf("/")), { recursive: true, force: true });
if (errors.length) process.exit(1);
