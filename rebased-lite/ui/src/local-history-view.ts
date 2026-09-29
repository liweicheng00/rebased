// Local History, as in IntelliJ: the versions that the app kept of a file, a directory, or all files.
// The diff shows the selected version on the left and the current file on the right.

import type { FileContent, LocalRevision } from "./api";
import { dragResize, h } from "./dom";
import { sharedDiff } from "./history-view";

export interface LocalHistoryCallbacks {
  load: (path: string) => Promise<LocalRevision[]>;
  content: (blob: string | null) => Promise<Omit<FileContent, "size">>;
  current: (path: string) => Promise<FileContent>;
  /** Writes the version back to the file. Returns true when it did. */
  revert: (r: LocalRevision) => Promise<boolean>;
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Opens the Local History window. An empty path shows the recent changes of all files. */
export async function openLocalHistory(path: string, cb: LocalHistoryCallbacks) {
  const d = sharedDiff();
  const all = path === "";
  const list = h("div", { class: "history-list", tabIndex: 0 });
  const count = h("span", { class: "muted-inline" }, "Loading…");
  let entries: LocalRevision[] = [];
  let selected = -1;
  let request = 0;
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const revertBtn = h("button", { class: "tb-button", title: "Write the selected version back to the file", disabled: true }, "Revert");
  revertBtn.addEventListener("click", async () => {
    if (selected < 0) return;
    if (await cb.revert(entries[selected])) await load();
  });
  const closeBtn = h("button", { class: "tb-button" }, "Close");
  closeBtn.addEventListener("click", close);
  const grip = h("div", { class: "vgrip" });
  const body = h("div", { class: "history-body" }, list, grip, d.el);
  const title = all ? h("b", {}, "Local History: recent changes") : h("span", {}, h("b", {}, "Local History of "), h("code", {}, path));
  const win = h(
    "div",
    { class: "history-window", role: "dialog", "aria-label": all ? "Local History" : `Local History of ${path}` },
    h("div", { class: "merge-header" }, title, " ", count, h("span", { class: "spacer" }), revertBtn, closeBtn),
    body,
  );
  const overlay = h("div", { class: "merge-overlay" }, win);
  document.body.append(overlay);
  let width = all ? 560 : 420;
  body.style.gridTemplateColumns = `${width}px 4px minmax(0, 1fr)`;
  let start = 0;
  dragResize(grip, "x", () => (start = width), (dx) => {
    width = Math.max(220, Math.min(900, start + dx));
    body.style.gridTemplateColumns = `${width}px 4px minmax(0, 1fr)`;
  }, () => {});
  d.onHistory = () => {};
  d.onNextFile = () => void select(Math.min(entries.length - 1, selected + 1));
  d.onPrevFile = () => void select(Math.max(0, selected - 1));
  d.message("Loading…");

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && document.activeElement === list) {
      e.preventDefault();
      void select(Math.max(0, Math.min(entries.length - 1, selected + (e.key === "ArrowDown" ? 1 : -1))));
    }
  };
  document.addEventListener("keydown", onKey, true);

  const select = async (i: number) => {
    if (i < 0 || i >= entries.length) return;
    selected = i;
    revertBtn.disabled = false;
    for (const [j, el] of [...list.children].entries()) el.classList.toggle("selected", j === i);
    list.children[i]?.scrollIntoView({ block: "nearest" });
    const e = entries[i];
    const req = ++request;
    d.setSides(formatTime(e.time), "Current");
    try {
      const [left, right] = await Promise.all([cb.content(e.blob), cb.current(e.path)]);
      if (req !== request) return;
      const status = left.missing ? "A" : right.missing ? "D" : "M";
      d.setSource(null);
      d.show({ status, path: e.path, old_path: null }, { ...left, size: 0 }, right);
    } catch (err) {
      if (req === request) d.message(String(err));
    }
  };

  const load = async () => {
    try {
      entries = await cb.load(path);
    } catch (e) {
      count.textContent = String(e).replace(/^Error: /, "");
      d.message("");
      return;
    }
    count.textContent = `${entries.length} version${entries.length === 1 ? "" : "s"}`;
    list.replaceChildren(
      ...entries.map((e, i) => {
        const row = h(
          "div",
          { class: "local-history-row", title: e.path },
          h("span", { class: "rebase-author" }, formatTime(e.time)),
          h("span", { class: `local-history-label${e.label ? "" : " muted-inline"}` }, e.label || (e.blob ? "Changed" : "Deleted")),
          all ? h("span", { class: "rebase-subject" }, e.path) : h("span"),
        );
        row.addEventListener("mousedown", () => void select(i));
        return row;
      }),
    );
    selected = -1;
    revertBtn.disabled = true;
    if (!entries.length) d.message(all ? "Local History has no versions yet. It keeps a version when a file changes." : "Local History has no versions of this file.");
    else void select(0);
    list.focus();
  };
  await load();
}
