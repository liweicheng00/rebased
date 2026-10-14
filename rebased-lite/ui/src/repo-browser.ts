// Show Repository at Revision, as in IntelliJ: all files of a commit as a tree of folders, and the content
// of the selected file. The window only reads; it changes no file.

import { visit } from "./nav";
import { registerWindow } from "./windows";
import type { FileContent } from "./api";
import { editorFont, languageFor } from "./diff-view";
import { dragResize, h, twisty } from "./dom";
import { fileIcon } from "./file-icon";
import { buildTree, treeOrder, walkTree } from "./file-tree";
import * as monaco from "./monaco";

export interface RepoBrowserCallbacks {
  files: (oid: string) => Promise<string[]>;
  content: (oid: string, path: string) => Promise<FileContent>;
  showHistory: (path: string) => void;
  copyText: (text: string) => void;
}

/** Opens the window for a commit. `label` names the commit in the title; `path` shows that file first. */
export async function openRepoBrowser(oid: string, label: string, cb: RepoBrowserCallbacks, path?: string) {
  let paths: string[] = [];
  let selected = "";
  let request = 0;
  /** The folders that are open. All folders are closed at first. */
  const open = new Set<string>();
  const search = h("input", { class: "dialog-input repo-browser-search", type: "search", placeholder: "Find a file by its path", spellcheck: false });
  const list = h("div", { class: "history-list repo-browser-files", tabIndex: 0 });
  const count = h("span", { class: "muted-inline" }, "Loading…");
  const title = h("div", { class: "repo-browser-file" }, "Select a file.");
  const host = h("div", { class: "repo-browser-editor" });
  const note = h("div", { class: "muted-inline repo-browser-note" });
  const viewer = h("div", { class: "repo-browser-viewer" }, title, note, host);
  const editor = monaco.editor.create(host, { readOnly: true, automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false, renderLineHighlight: "none", ...editorFont() });
  const historyBtn = h("button", { class: "tb-button", title: "Show the history of the selected file", disabled: true }, "Show History");
  historyBtn.addEventListener("click", () => selected && cb.showHistory(selected));
  const copyBtn = h("button", { class: "tb-button", title: "Copy the path of the selected file", disabled: true }, "Copy Path");
  copyBtn.addEventListener("click", () => selected && cb.copyText(selected));
  const closeBtn = h("button", { class: "tb-button" }, "Close");
  const grip = h("div", { class: "vgrip" });
  const side = h("div", { class: "compare-side" }, search, list);
  const body = h("div", { class: "history-body" }, side, grip, viewer);
  const win = h(
    "div",
    { class: "history-window", role: "dialog", "aria-label": `Repository at ${label}` },
    h("div", { class: "merge-header" }, h("b", {}, "Repository at "), h("code", {}, label), " ", count, h("span", { class: "spacer" }), historyBtn, copyBtn, closeBtn),
    body,
  );
  const overlay = h("div", { class: "merge-overlay" }, win);
  document.body.append(overlay);
  // Back and Forward close the window before they open another place.
  const unregister = registerWindow(() => close());
  let width = 380;
  body.style.gridTemplateColumns = `${width}px 4px minmax(0, 1fr)`;
  let start = 0;
  dragResize(grip, "x", () => (start = width), (dx) => {
    width = Math.max(220, Math.min(900, start + dx));
    body.style.gridTemplateColumns = `${width}px 4px minmax(0, 1fr)`;
  }, () => {});

  const close = () => {
    unregister();
    editor.getModel()?.dispose();
    editor.dispose();
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  closeBtn.addEventListener("click", close);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !document.querySelector(".overlay")) {
      e.preventDefault();
      close();
    }
  };
  document.addEventListener("keydown", onKey, true);

  const show = async (path: string) => {
    selected = path;
    visit({ key: `tree\0${oid}\0${path}`, label: `${label}: ${path}`, open: () => openRepoBrowser(oid, label, cb, path) });
    historyBtn.disabled = copyBtn.disabled = false;
    for (const el of list.querySelectorAll<HTMLElement>(".repo-browser-row")) el.classList.toggle("selected", el.dataset.path === path);
    title.replaceChildren(fileIcon(path), h("code", {}, path));
    const req = ++request;
    try {
      const c = await cb.content(oid, path);
      if (req !== request) return;
      const text = c.binary ? "" : (c.text ?? "");
      note.textContent = c.note ?? (c.binary ? `A binary file of ${c.size} bytes.` : "");
      note.hidden = !note.textContent;
      host.hidden = c.binary;
      editor.getModel()?.dispose();
      editor.setModel(monaco.editor.createModel(text, languageFor(path)));
    } catch (err) {
      if (req !== request) return;
      note.textContent = String(err).replace(/^Error: /, "");
      note.hidden = false;
      host.hidden = true;
    }
  };

  const fileRow = (path: string, depth: number, withDir: boolean) => {
    const slash = path.lastIndexOf("/");
    const row = h(
      "div",
      { class: "history-row repo-browser-row" + (path === selected ? " selected" : ""), "data-path": path, title: path, style: { paddingLeft: `${8 + depth * 16}px` } },
      fileIcon(path),
      h("span", { class: "rebase-subject" }, path.slice(slash + 1)),
      withDir && slash > 0 ? h("span", { class: "rebase-author" }, path.slice(0, slash)) : "",
    );
    row.addEventListener("mousedown", (e) => e.button === 0 && void show(path));
    return row;
  };

  const render = () => {
    const q = search.value.trim().toLowerCase();
    if (q) {
      // A search shows the matching files as a flat list.
      const hits = paths.filter((p) => p.toLowerCase().includes(q));
      count.textContent = `${hits.length} of ${paths.length} files`;
      list.replaceChildren(...hits.slice(0, 2000).map((p) => fileRow(p, 0, true)));
      return;
    }
    count.textContent = `${paths.length} files`;
    const out: HTMLElement[] = [];
    // walkTree takes the closed folders: all folders that are not open.
    const closed = new Set<string>();
    for (const p of paths) {
      let at = p.indexOf("/");
      while (at > 0) {
        const dir = p.slice(0, at + 1);
        if (!open.has(dir)) closed.add(dir);
        at = p.indexOf("/", at + 1);
      }
    }
    walkTree(buildTree(paths.map((path, index) => ({ path, index }))), closed, {
      dir: (label, full, depth, isOpen, n) => {
        const row = h(
          "div",
          { class: "history-row compare-dir", style: { paddingLeft: `${8 + depth * 16}px` }, title: full },
          twisty(isOpen),
          h("span", { class: "dir-name" }, label),
          h("span", { class: "dir-count" }, String(n)),
        );
        row.addEventListener("mousedown", (e) => {
          if (e.button !== 0) return;
          // A row of joined folders ("a/b/c") opens all of them.
          const parts = full.slice(0, -1).split("/");
          for (let i = 1; i <= parts.length; i++) {
            const dir = parts.slice(0, i).join("/") + "/";
            if (isOpen) open.delete(dir);
            else open.add(dir);
          }
          render();
        });
        out.push(row);
      },
      file: (index, depth) => out.push(fileRow(paths[index], depth, false)),
    });
    list.replaceChildren(...out);
  };
  search.addEventListener("input", render);

  try {
    paths = (await cb.files(oid)).sort(treeOrder);
    if (path && paths.includes(path)) {
      // The folders of the first file open.
      for (let at = path.indexOf("/"); at > 0; at = path.indexOf("/", at + 1)) open.add(path.slice(0, at + 1));
    }
    render();
    if (path && paths.includes(path)) void show(path);
  } catch (err) {
    count.textContent = String(err).replace(/^Error: /, "");
  }
}
