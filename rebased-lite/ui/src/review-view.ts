// The review window: the changes of a branch from the commit where it started, as in a pull request. The
// user marks files as viewed, adds notes to lines, and merges the branch from here.

import type { Change, FileContent, ReviewComment, ReviewDetail, ReviewEdit, ReviewSummary, RevSpec } from "./api";
import { statusName } from "./changes-panel";
import { dragResize, formatDate, h } from "./dom";
import { fileIcon } from "./file-icon";
import { buildTree, treeOrder, walkTree } from "./file-tree";
import { sharedDiff } from "./history-view";
import { save, settings } from "./settings";

export interface ReviewCallbacks {
  /** All reviews, for the switcher in the header. */
  list: () => ReviewSummary[];
  load: (branch: string) => Promise<ReviewDetail>;
  edit: (e: ReviewEdit) => Promise<void>;
  changes: (left: RevSpec, right: RevSpec) => Promise<Change[]>;
  pair: (left: RevSpec, right: RevSpec, path: string, oldPath: string | null) => Promise<{ left: FileContent; right: FileContent }>;
  /** Opens the Merge dialog. True when the branch was merged. */
  finish: (d: ReviewDetail) => Promise<boolean>;
  showInLog: (oid: string) => void;
}

interface Row {
  status: string;
  path: string;
  oldPath: string | null;
  viewed?: boolean;
  comments?: number;
}

let closeOpen: (() => void) | null = null;

export async function openReview(branch: string, cb: ReviewCallbacks) {
  closeOpen?.();
  const d = sharedDiff();
  let current = branch;
  let detail: ReviewDetail | null = null;
  /** "all" for the changes of the branch, or the oid of one commit. */
  let scope = "all";
  let rows: Row[] = [];
  let selected = -1;
  let request = 0;

  const switcher = h("select", { class: "dialog-input review-switcher", title: "Switch to another review" });
  const info = h("span", { class: "muted-inline review-info" });
  const finishBtn = h("button", { class: "tb-button primary review-merge" }, "Merge…");
  const closeBtn = h("button", { class: "tb-button" }, "Close");
  const status = h("div", { class: "review-status" });
  const commitsEl = h("div", { class: "review-commits" });
  const filesTitle = h("div", { class: "compare-files-title review-files-title" });
  const treeBtn = h("button", { class: "icon-button review-tree-toggle" });
  treeBtn.addEventListener("click", () => {
    settings.reviewAsTree = !settings.reviewAsTree;
    save();
    const keep = rows[selected]?.path;
    if (settings.reviewAsTree) rows.sort((a, b) => treeOrder(a.path, b.path));
    else rows.sort((a, b) => a.path.localeCompare(b.path));
    selected = keep ? rows.findIndex((r) => r.path === keep) : -1;
    renderFiles();
  });
  const filesEl = h("div", { class: "history-list review-files", tabIndex: 0 });
  const notesTitle = h("div", { class: "review-notes-title" });
  const notesList = h("div", { class: "review-notes-list" });
  const noteText = h("textarea", { class: "dialog-input review-note-text", rows: 2, placeholder: "A note on the line of the cursor (Ctrl+Enter adds it)", spellcheck: false });
  const noteBtn = h("button", { class: "tb-button" }, "Add Note");
  const notes = h("div", { class: "review-notes" }, notesTitle, notesList, h("div", { class: "review-note-form" }, noteText, noteBtn));
  const side = h("div", { class: "compare-side" }, h("div", { class: "compare-files-title" }, "Commits"), commitsEl, filesTitle, filesEl);
  const right = h("div", { class: "review-right" }, d.el, notes);
  const grip = h("div", { class: "vgrip" });
  const body = h("div", { class: "history-body" }, side, grip, right);
  const win = h(
    "div",
    { class: "history-window review-window", role: "dialog", "aria-label": "Review" },
    h("div", { class: "merge-header compare-header" }, h("b", {}, "Review"), switcher, info, h("span", { class: "spacer" }), finishBtn, closeBtn),
    status,
    body,
  );
  const overlay = h("div", { class: "merge-overlay" }, win);
  document.body.append(overlay);
  let width = 420;
  body.style.gridTemplateColumns = `${width}px 4px minmax(0, 1fr)`;
  let start = 0;
  dragResize(grip, "x", () => (start = width), (dx) => {
    width = Math.max(260, Math.min(900, start + dx));
    body.style.gridTemplateColumns = `${width}px 4px minmax(0, 1fr)`;
  }, () => {});

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
    closeOpen = null;
  };
  closeOpen = close;
  closeBtn.addEventListener("click", close);
  const onKey = (e: KeyboardEvent) => {
    if (document.querySelector(".overlay")) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (document.activeElement === filesEl && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      // Up and down go through the files that show; a closed folder hides its files.
      const shown = [...filesEl.querySelectorAll<HTMLElement>(".review-file")].map((el) => Number(el.dataset.index));
      const at = shown.indexOf(selected);
      const next = shown[Math.max(0, Math.min(shown.length - 1, at < 0 ? 0 : at + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next !== undefined) void select(next);
    } else if (document.activeElement === filesEl && e.key === " " && scope === "all" && rows[selected]) {
      e.preventDefault();
      void setViewed(rows[selected], !rows[selected].viewed);
    }
  };
  document.addEventListener("keydown", onKey, true);
  d.onHistory = () => {};
  d.onNextFile = () => void select(Math.min(rows.length - 1, selected + 1));
  d.onPrevFile = () => void select(Math.max(0, selected - 1));

  const fillSwitcher = () => {
    const list = cb.list();
    const names = list.some((r) => r.branch === current) ? list : [...list, { branch: current, base: detail?.summary.base ?? "" } as ReviewSummary];
    switcher.replaceChildren(...names.map((r) => h("option", { value: r.branch, selected: r.branch === current }, `${r.branch} → ${r.base}`)));
  };
  switcher.addEventListener("change", () => {
    current = switcher.value;
    scope = "all";
    void load();
  });

  const revs = (): { l: RevSpec; r: RevSpec } | null => {
    if (!detail) return null;
    return scope === "all" ? { l: { commit: detail.mergeBase }, r: { commit: detail.head } } : { l: { parentOf: scope }, r: { commit: scope } };
  };

  const fileNotes = (path: string): ReviewComment[] => (detail?.commentList ?? []).filter((c) => c.path === path).sort((a, b) => a.line - b.line);

  const renderStatus = () => {
    if (!detail) return;
    const s = detail.summary;
    info.textContent = ` ${s.commits} commit(s) · ${s.files} file(s) · ${s.viewed}/${s.files} viewed · ${s.comments} note(s)`;
    const parts: (Node | string)[] = [];
    if (s.merged) parts.push(h("span", { class: "review-ok" }, `✓ ${s.base} has all the commits of ${s.branch}.`));
    else if (!s.exists) parts.push(h("span", { class: "danger-text" }, `${s.branch} or ${s.base} is not a local branch any more.`));
    else if (s.conflicts.length) parts.push(h("span", { class: "danger-text" }, `⚠ ${s.conflicts.length} file(s) conflict with ${s.base}: ${s.conflicts.join(", ")}`));
    else parts.push(h("span", { class: "review-ok" }, `✓ No conflicts with ${s.base}.`));
    if (s.behind) parts.push(h("span", { class: "muted-inline" }, ` ${s.base} has ${s.behind} commit(s) that ${s.branch} does not have.`));
    status.replaceChildren(...parts);
    finishBtn.disabled = !s.exists || s.merged;
    filesTitle.replaceChildren(
      scope === "all" ? `Files · ${s.viewed}/${s.files} viewed` : "Files of the commit",
      treeBtn,
      h("div", { class: "review-progress" }, h("div", { class: "review-progress-bar", style: { width: `${s.files ? Math.round((s.viewed / s.files) * 100) : 0}%` } })),
    );
  };

  const renderCommits = () => {
    if (!detail) return;
    const all = h("div", { class: "history-row review-commit" + (scope === "all" ? " selected" : "") }, h("b", {}, "All changes"), h("span", { class: "muted-inline" }, ` from ${detail.mergeBase.slice(0, 8)}`));
    all.addEventListener("mousedown", () => setScope("all"));
    const list = detail.commitList.map((c) => {
      const row = h(
        "div",
        { class: "history-row review-commit" + (scope === c.oid ? " selected" : ""), title: `${c.oid}\n${c.subject}\nDouble-click: show in the log` },
        h("code", { class: "rebase-hash" }, c.oid.slice(0, 8)),
        h("span", { class: "rebase-subject" }, c.subject),
        h("span", { class: "rebase-author" }, formatDate(c.time)),
      );
      row.addEventListener("mousedown", () => setScope(c.oid));
      row.addEventListener("dblclick", () => {
        close();
        cb.showInLog(c.oid);
      });
      return row;
    });
    commitsEl.replaceChildren(all, ...list);
  };

  /** The folders that the user closed in the tree, by path. */
  const collapsed = new Set<string>();

  const fileRow = (f: Row, i: number, depth: number, withDir: boolean) => {
    const slash = f.path.lastIndexOf("/");
    const box = h("input", { type: "checkbox", class: "review-viewed", checked: !!f.viewed, title: "Viewed (Space)" });
    box.addEventListener("mousedown", (e) => e.stopPropagation());
    box.addEventListener("change", () => void setViewed(f, box.checked));
    const row = h(
      "div",
      {
        class: "history-row review-file" + (i === selected ? " selected" : "") + (f.viewed ? " viewed" : ""),
        "data-index": i,
        title: f.oldPath ? `${f.oldPath} → ${f.path}` : f.path,
        style: { paddingLeft: `${8 + depth * 14}px` },
      },
      scope === "all" ? box : "",
      fileIcon(f.path),
      h("span", { class: `rebase-subject status-text-${f.status}` }, f.path.slice(slash + 1)),
      h("span", { class: "rebase-author" }, withDir && slash > 0 ? f.path.slice(0, slash) : ""),
      f.comments ? h("span", { class: "review-file-notes", title: `${f.comments} note(s)` }, `💬${f.comments}`) : h("span", {}),
      h("span", { class: `status status-end status-${f.status}`, title: statusName(f.status) }, f.status),
    );
    row.addEventListener("mousedown", () => void select(i));
    return row;
  };

  const renderFiles = () => {
    treeBtn.textContent = settings.reviewAsTree ? "☰" : "🗀";
    treeBtn.title = settings.reviewAsTree ? "Show as a flat list" : "Group by folder";
    if (!settings.reviewAsTree) {
      filesEl.replaceChildren(...rows.map((f, i) => fileRow(f, i, 0, true)));
      return;
    }
    const tree = buildTree(rows.map((r, index) => ({ path: r.path, index })));
    const out: HTMLElement[] = [];
    walkTree(tree, collapsed, {
      dir: (label, full, depth, open, count, viewed) => {
        const row = h(
          "div",
          { class: "history-row review-dir" + (count && viewed === count ? " viewed" : ""), style: { paddingLeft: `${8 + depth * 14}px` }, title: full },
          h("span", { class: "twisty" }, open ? "▾" : "▸"),
          h("span", { class: "dir-name" }, label),
          h("span", { class: "dir-count" }, scope === "all" ? `${viewed}/${count}` : String(count)),
        );
        row.addEventListener("mousedown", () => {
          if (open) collapsed.add(full);
          else collapsed.delete(full);
          renderFiles();
        });
        out.push(row);
      },
      file: (index, depth) => out.push(fileRow(rows[index], index, depth, false)),
      viewed: (index) => !!rows[index].viewed,
    });
    filesEl.replaceChildren(...out);
  };

  const renderNotes = () => {
    const f = rows[selected];
    const can = scope === "all" && !!f && f.status !== "D";
    noteText.disabled = !can;
    noteBtn.disabled = !can;
    if (!f) {
      notesTitle.textContent = "Notes";
      notesList.replaceChildren();
      return;
    }
    const list = fileNotes(f.path);
    notesTitle.textContent = scope === "all" ? `Notes in ${f.path}` : "Notes are on the changes of the whole branch. Choose All changes to add one.";
    notesList.replaceChildren(
      ...list.map((c) => {
        const del = h("button", { class: "icon-button", title: "Delete the note" }, "✕");
        del.addEventListener("click", async (e) => {
          e.stopPropagation();
          await cb.edit({ action: "deleteComment", branch: current, id: c.id });
          await reload();
        });
        const row = h(
          "div",
          { class: "review-note" + (c.outdated ? " outdated" : ""), title: c.outdated ? "The file changed after this note. The line can be another line now." : "Go to the line" },
          h("span", { class: "review-note-line-no" }, `L${c.line}`),
          h("span", { class: "review-note-body" }, c.text),
          c.outdated ? h("span", { class: "muted-inline" }, "outdated") : "",
          h("span", { class: "muted-inline" }, formatDate(c.time)),
          del,
        );
        row.addEventListener("click", () => scope === "all" && d.revealLine(c.line));
        return row;
      }),
    );
    if (scope === "all") d.setNotes(list.map((c) => ({ line: c.line, text: c.text })));
  };

  const addNote = async () => {
    const f = rows[selected];
    const text = noteText.value.trim();
    if (!f || !text || scope !== "all") return;
    await cb.edit({ action: "comment", branch: current, path: f.path, line: d.cursorLine(), text });
    noteText.value = "";
    await reload();
  };
  noteBtn.addEventListener("click", () => void addNote());
  noteText.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void addNote();
    }
  });

  const setViewed = async (f: Row, viewed: boolean) => {
    await cb.edit({ action: "viewed", branch: current, paths: [f.path], viewed });
    await reload();
  };

  const select = async (i: number) => {
    const rv = revs();
    if (i < 0 || i >= rows.length || !rv) return;
    selected = i;
    for (const el of filesEl.querySelectorAll<HTMLElement>(".review-file")) el.classList.toggle("selected", Number(el.dataset.index) === i);
    filesEl.querySelector(`.review-file[data-index="${i}"]`)?.scrollIntoView({ block: "nearest" });
    const f = rows[i];
    const req = ++request;
    try {
      const pair = await cb.pair(rv.l, rv.r, f.path, f.oldPath);
      if (req !== request) return;
      d.setSource(f.status === "D" ? { path: f.oldPath ?? f.path, rev: rv.l } : { path: f.path, rev: rv.r });
      d.show({ status: f.status, path: f.path, old_path: f.oldPath }, pair.left, pair.right);
      renderNotes();
    } catch (err) {
      if (req === request) d.message(String(err));
    }
  };

  const setScope = async (s: string) => {
    scope = s;
    selected = -1;
    await showFiles();
  };

  /** Fills the file list for the scope, and keeps the selected file when it is still there. */
  const showFiles = async (keep?: string) => {
    if (!detail) return;
    renderCommits();
    renderStatus();
    if (scope === "all") {
      rows = detail.fileList.map((f) => ({ status: f.status, path: f.path, oldPath: f.oldPath, viewed: f.viewed, comments: f.comments }));
      d.setSides(`${detail.summary.base} (from ${detail.mergeBase.slice(0, 8)})`, detail.summary.branch);
    } else {
      const rv = revs()!;
      rows = (await cb.changes(rv.l, rv.r)).map((c) => ({ status: c.status, path: c.path, oldPath: c.old_path }));
      d.setSides(`${scope.slice(0, 8)}^`, scope.slice(0, 8));
    }
    if (settings.reviewAsTree) rows.sort((a, b) => treeOrder(a.path, b.path));
    const i = keep ? rows.findIndex((r) => r.path === keep) : -1;
    selected = -1;
    renderFiles();
    if (i >= 0) {
      selected = i;
      renderFiles();
      renderNotes();
    } else if (rows.length) await select(0);
    else {
      d.message(detail.summary.exists ? "The branch has no changes from the merge base." : "");
      renderNotes();
    }
  };

  /** Loads the review again after a change, and keeps the selected file. */
  const reload = async () => {
    const keep = rows[selected]?.path;
    detail = await cb.load(current);
    await showFiles(keep);
  };

  const load = async () => {
    fillSwitcher();
    commitsEl.replaceChildren(h("div", { class: "muted-inline" }, "Loading…"));
    filesEl.replaceChildren();
    d.message("Loading…");
    try {
      detail = await cb.load(current);
      fillSwitcher();
      await showFiles();
    } catch (e) {
      commitsEl.replaceChildren(h("div", { class: "settings-hint error" }, String(e).replace(/^Error: /, "")));
      d.message("");
    }
  };

  finishBtn.addEventListener("click", async () => {
    if (!detail) return;
    if (await cb.finish(detail)) close();
  });
  await load();
}
