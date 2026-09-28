import "./style.css";
import { api, initialPath, type Row } from "./api";
import { CompareView } from "./compare-view";
import { LogView } from "./log-view";

const app = document.getElementById("app")!;
app.innerHTML = `
  <header class="toolbar">
    <input id="repo" class="repo" placeholder="Path to a git repository" spellcheck="false" />
    <button id="open">Open</button>
    <label><input type="checkbox" id="sort" checked /> IntelliSort</label>
    <label><input type="checkbox" id="long" /> Show long edges</label>
    <span class="sep"></span>
    <button id="worktree" disabled>Compare with working tree</button>
    <button id="swap">Swap sides</button>
    <button id="layout">Unified diff</button>
    <span id="status" class="status"></span>
  </header>
  <main class="split">
    <section id="top" class="pane"></section>
    <div id="splitter" class="splitter"></div>
    <section id="bottom" class="pane"></section>
  </main>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const log = new LogView();
const compare = new CompareView();
$("top").append(log.el);
$("bottom").append(compare.el);

const repoInput = $<HTMLInputElement>("repo");
const status = $("status");
let selected: Row[] = [];

async function open() {
  const path = repoInput.value.trim();
  if (!path) return;
  status.textContent = "Loading…";
  try {
    const r = await api.open(path, $<HTMLInputElement>("sort").checked, $<HTMLInputElement>("long").checked);
    try {
      localStorage.setItem("rebased-lite.repo", path);
    } catch {}
    document.title = `${r.root} – Rebased Lite`;
    status.textContent = `${r.rowCount.toLocaleString()} commits · loaded in ${r.loadMs} ms`;
    log.reset(r.rowCount, r.recommendedWidth);
  } catch (e) {
    status.textContent = String(e);
  }
}

log.onSelectionChange = (rows) => {
  selected = rows;
  $<HTMLButtonElement>("worktree").disabled = rows.length !== 1;
  void compare.showSelection(rows);
};

$("open").addEventListener("click", () => void open());
repoInput.addEventListener("keydown", (e) => e.key === "Enter" && void open());
$("sort").addEventListener("change", () => void open());
$("long").addEventListener("change", () => void open());
$("worktree").addEventListener("click", () => selected.length === 1 && void compare.compareWithWorktree(selected[0]));
$("swap").addEventListener("click", () => compare.swap());
$("layout").addEventListener("click", (e) => {
  (e.target as HTMLElement).textContent = compare.toggleSideBySide() ? "Unified diff" : "Side-by-side diff";
});

// Drag the splitter to resize the log and the compare panel.
const splitter = $("splitter");
splitter.addEventListener("mousedown", (e) => {
  e.preventDefault();
  const main = splitter.parentElement!;
  const move = (ev: MouseEvent) => {
    const rect = main.getBoundingClientRect();
    const ratio = Math.min(0.85, Math.max(0.15, (ev.clientY - rect.top) / rect.height));
    main.style.gridTemplateRows = `${ratio}fr 5px ${1 - ratio}fr`;
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
});

let initial = new URLSearchParams(location.search).get("repo") ?? (await initialPath());
if (!initial) {
  try {
    initial = localStorage.getItem("rebased-lite.repo");
  } catch {}
}
if (initial) {
  repoInput.value = initial;
  void open();
}
