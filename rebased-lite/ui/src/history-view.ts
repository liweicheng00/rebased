// The history of one file, as IntelliJ's Show History: the commits that changed the file, and the
// change of the file in the selected commit.

import type { Blame, FileContent, HistoryEntry, RevSpec } from "./api";
import { DiffView } from "./diff-view";
import { dragResize, formatDate, h } from "./dom";

export interface HistoryCallbacks {
  load: (path: string) => Promise<HistoryEntry[]>;
  pair: (left: RevSpec, right: RevSpec, path: string, oldPath: string | null) => Promise<{ left: FileContent; right: FileContent }>;
  blame: (path: string, rev: RevSpec) => Promise<Blame>;
  showInLog: (oid: string) => void;
}

let diff: DiffView | null = null;

/** One diff view for all history windows: Monaco editors are expensive. */
export function sharedDiff(): DiffView {
  diff ??= new DiffView();
  return diff;
}

export async function openHistory(path: string, cb: HistoryCallbacks) {
  const d = sharedDiff();
  const list = h("div", { class: "history-list", tabIndex: 0 });
  const count = h("span", { class: "muted-inline" }, "Loading…");
  let entries: HistoryEntry[] = [];
  let selected = -1;
  let request = 0;
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const jump = () => {
    if (selected < 0) return;
    close();
    cb.showInLog(entries[selected].oid);
  };
  const logBtn = h("button", { class: "tb-button", title: "Select the commit in the log and close" }, "Show in Log");
  logBtn.addEventListener("click", jump);
  const closeBtn = h("button", { class: "tb-button" }, "Close");
  closeBtn.addEventListener("click", close);
  const grip = h("div", { class: "vgrip" });
  const body = h("div", { class: "history-body" }, list, grip, d.el);
  const win = h(
    "div",
    { class: "history-window", role: "dialog", "aria-label": `History of ${path}` },
    h("div", { class: "merge-header" }, h("b", {}, "History of "), h("code", {}, path), " ", count, h("span", { class: "spacer" }), logBtn, closeBtn),
    body,
  );
  const overlay = h("div", { class: "merge-overlay" }, win);
  document.body.append(overlay);
  let width = 520;
  body.style.gridTemplateColumns = `${width}px 4px minmax(0, 1fr)`;
  let start = 0;
  dragResize(grip, "x", () => (start = width), (dx) => {
    width = Math.max(220, Math.min(900, start + dx));
    body.style.gridTemplateColumns = `${width}px 4px minmax(0, 1fr)`;
  }, () => {});
  d.onBlame = cb.blame;
  d.onBlameClick = (oid) => {
    const i = entries.findIndex((e) => e.oid === oid);
    if (i >= 0) select(i);
    else {
      close();
      cb.showInLog(oid);
    }
  };
  d.onHistory = () => {};
  d.onNextFile = () => select(Math.min(entries.length - 1, selected + 1));
  d.onPrevFile = () => select(Math.max(0, selected - 1));
  d.message("Loading…");

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && document.activeElement === list) {
      e.preventDefault();
      select(Math.max(0, Math.min(entries.length - 1, selected + (e.key === "ArrowDown" ? 1 : -1))));
    }
  };
  document.addEventListener("keydown", onKey, true);

  const select = async (i: number) => {
    if (i < 0 || i >= entries.length) return;
    selected = i;
    for (const [j, el] of [...list.children].entries()) el.classList.toggle("selected", j === i);
    list.children[i]?.scrollIntoView({ block: "nearest" });
    const e = entries[i];
    const req = ++request;
    const left: RevSpec = e.parents.length ? { commit: e.parents[0] } : { parentOf: e.oid };
    const right: RevSpec = { commit: e.oid };
    d.setSides(e.parents.length ? e.parents[0].slice(0, 8) : "empty", e.oid.slice(0, 8));
    try {
      const pair = await cb.pair(left, right, e.path, e.oldPath);
      if (req !== request) return;
      const deleted = e.status === "D";
      d.setSource(deleted ? (e.parents.length ? { path: e.oldPath ?? e.path, rev: left } : null) : { path: e.path, rev: right });
      d.show({ status: e.status || "M", path: e.path, old_path: e.oldPath }, pair.left, pair.right);
    } catch (err) {
      if (req === request) d.message(String(err));
    }
  };

  try {
    entries = await cb.load(path);
  } catch (e) {
    count.textContent = String(e).replace(/^Error: /, "");
    d.message("");
    return;
  }
  count.textContent = `${entries.length} commit${entries.length === 1 ? "" : "s"}${entries.length >= 5000 ? " (the newest 5000)" : ""}`;
  list.replaceChildren(
    ...entries.map((e, i) => {
      const row = h(
        "div",
        { class: "history-row", title: e.oldPath ? `${e.oldPath} → ${e.path}` : e.path },
        h("code", { class: "rebase-hash" }, e.oid.slice(0, 8)),
        h("span", { class: `status status-${e.status || "M"}` }, e.status || "·"),
        h("span", { class: "rebase-subject" }, e.subject),
        h("span", { class: "rebase-author" }, e.author),
        h("span", { class: "rebase-author" }, formatDate(e.time)),
      );
      row.addEventListener("mousedown", () => void select(i));
      row.addEventListener("dblclick", jump);
      return row;
    }),
  );
  if (!entries.length) d.message("The file has no commits.");
  else void select(0);
  list.focus();
}
