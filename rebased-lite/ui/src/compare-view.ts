// Compare Branches, as IntelliJ's "Compare with Current": the commits that each side has and the other
// has not, the changed files, and the diff of the selected file.

import type { Change, FileContent, OutgoingCommit, RevSpec } from "./api";
import { statusName } from "./changes-panel";
import { dragResize, formatDate, h, rowSplitter } from "./dom";
import { showMenu } from "./context-menu";
import { save, settings } from "./settings";
import { sharedDiff } from "./history-view";

/** The working tree, as the right side. */
export const WORKTREE = "\u0000worktree";

export interface CompareCallbacks {
  /** The names that the two sides can use: branches and tags. */
  refs: string[];
  compareRefs: (left: string, right: string) => Promise<{ left: string; right: string; base: string | null; onlyLeft: OutgoingCommit[]; onlyRight: OutgoingCommit[] }>;
  changes: (left: RevSpec, right: RevSpec) => Promise<Change[]>;
  pair: (left: RevSpec, right: RevSpec, path: string, oldPath: string | null) => Promise<{ left: FileContent; right: FileContent }>;
  showInLog: (oid: string) => void;
  /** The ref of HEAD, for a comparison with the working tree. */
  head: string;
  /** Makes working-tree files the same as at `rev`, after a question. True when it did. */
  revertFiles: (rev: string, name: string, paths: string[]) => Promise<boolean>;
  /** Writes the text of a working-tree file when the text on disk is still `expected`. True when it did. */
  writeFile: (path: string, text: string, expected: string) => Promise<boolean>;
  openInEditor: (path: string) => void;
  copyText: (text: string) => void;
}

/** Opens the window. `path` is the file to show first; without it, the first file. */
export async function openCompare(leftRef: string, rightRef: string, cb: CompareCallbacks, path?: string) {
  const d = sharedDiff();
  let left = leftRef;
  let right = rightRef;
  let fromBase = false;
  let files: Change[] = [];
  let revs: { l: RevSpec; r: RevSpec } | null = null;
  let selected = -1;
  let request = 0;

  const option = (name: string, value = name) => h("option", { value }, name);
  const leftSel = h("select", { class: "dialog-input compare-select", title: "The left side" }, ...cb.refs.map((r) => option(r)));
  const rightSel = h("select", { class: "dialog-input compare-select", title: "The right side" }, ...cb.refs.map((r) => option(r)), option("Working tree", WORKTREE));
  const swap = h("button", { class: "tb-button", title: "Swap the sides" }, "⇄");
  const mode = h(
    "select",
    { class: "dialog-input compare-select", title: "Which file changes to show" },
    h("option", { value: "tips" }, "Files: left → right"),
    h("option", { value: "base" }, "Files: common ancestor → right"),
  );
  const closeBtn = h("button", { class: "tb-button" }, "Close");
  const commitsEl = h("div", { class: "compare-commits" });
  const filesEl = h("div", { class: "history-list compare-files", tabIndex: 0 });
  const summary = h("span", { class: "muted-inline" }, "");
  const grip = h("div", { class: "vgrip" });
  const side = h("div", { class: "compare-side" });
  const sideGrip = rowSplitter(side, commitsEl, () => settings.compareCommitsHeight, (px) => (settings.compareCommitsHeight = px), save);
  side.append(commitsEl, sideGrip, h("div", { class: "compare-files-title" }, "Changed files ", summary), filesEl);
  const body = h("div", { class: "history-body" }, side, grip, d.el);
  const win = h(
    "div",
    { class: "history-window", role: "dialog", "aria-label": "Compare Branches" },
    h("div", { class: "merge-header compare-header" }, h("b", {}, "Compare"), leftSel, swap, rightSel, mode, h("span", { class: "spacer" }), closeBtn),
    body,
  );
  const overlay = h("div", { class: "merge-overlay" }, win);
  document.body.append(overlay);
  let width = 460;
  body.style.gridTemplateColumns = `${width}px 4px minmax(0, 1fr)`;
  let start = 0;
  dragResize(grip, "x", () => (start = width), (dx) => {
    width = Math.max(260, Math.min(900, start + dx));
    body.style.gridTemplateColumns = `${width}px 4px minmax(0, 1fr)`;
  }, () => {});

  const close = () => {
    d.setRevert(null);
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  closeBtn.addEventListener("click", close);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !document.querySelector(".overlay")) {
      e.preventDefault();
      close();
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && document.activeElement === filesEl) {
      e.preventDefault();
      void select(Math.max(0, Math.min(files.length - 1, selected + (e.key === "ArrowDown" ? 1 : -1))));
    }
  };
  document.addEventListener("keydown", onKey, true);
  d.onHistory = () => {};
  d.onNextFile = () => void select(Math.min(files.length - 1, selected + 1));
  d.onPrevFile = () => void select(Math.max(0, selected - 1));

  const commitList = (title: string, list: OutgoingCommit[]) => {
    const rows = list.map((c) => {
      const row = h(
        "div",
        { class: "history-row compare-commit", title: `${c.oid}\n${c.subject}\nDouble-click: show in the log` },
        h("code", { class: "rebase-hash" }, c.oid.slice(0, 8)),
        h("span", { class: "rebase-subject" }, c.subject),
        h("span", { class: "rebase-author" }, c.author),
        h("span", { class: "rebase-author" }, formatDate(c.time)),
      );
      row.addEventListener("dblclick", () => {
        close();
        cb.showInLog(c.oid);
      });
      return row;
    });
    return h(
      "section",
      { class: "compare-group" },
      h("div", { class: "compare-group-title" }, title, h("span", { class: "group-count" }, String(list.length) + (list.length >= 1000 ? "+" : ""))),
      ...(rows.length ? rows : [h("div", { class: "muted-inline compare-none" }, "None")]),
    );
  };

  const select = async (i: number) => {
    if (i < 0 || i >= files.length || !revs) return;
    selected = i;
    for (const [j, el] of [...filesEl.children].entries()) el.classList.toggle("selected", j === i);
    filesEl.children[i]?.scrollIntoView({ block: "nearest" });
    const c = files[i];
    const req = ++request;
    try {
      const pair = await cb.pair(revs.l, revs.r, c.path, c.old_path);
      if (req !== request) return;
      d.setSource(c.status === "D" ? { path: c.old_path ?? c.path, rev: revs.l } : { path: c.path, rev: revs.r });
      d.show(c, pair.left, pair.right);
    } catch (err) {
      if (req === request) d.message(String(err));
    }
  };

  const load = async () => {
    leftSel.value = left;
    rightSel.value = right;
    const req = ++request;
    commitsEl.replaceChildren(h("div", { class: "muted-inline" }, "Loading…"));
    filesEl.replaceChildren();
    d.message("Loading…");
    const worktree = right === WORKTREE;
    const rightName = worktree ? "the working tree" : right;
    try {
      const cmp = await cb.compareRefs(left, worktree ? cb.head : right);
      if (req !== request) return;
      // The commits of the working tree are the commits of HEAD.
      const rightCommits = worktree ? `${cb.head} (HEAD of the working tree)` : right;
      commitsEl.replaceChildren(
        ...(worktree && cmp.left === cmp.right
          ? [h("div", { class: "muted-inline compare-none" }, `The working tree is on ${cb.head}, at the same commit as ${left}. The files below are its local changes.`)]
          : [commitList(`In ${left}, not in ${rightCommits}`, cmp.onlyLeft), commitList(`In ${rightCommits}, not in ${left}`, cmp.onlyRight)]),
      );
      const l: RevSpec = { commit: fromBase && cmp.base ? cmp.base : cmp.left };
      const r: RevSpec = worktree ? "worktree" : { commit: cmp.right };
      revs = { l, r };
      const leftName = fromBase ? `the common ancestor ${cmp.base?.slice(0, 8) ?? ""}` : left;
      const leftRev = fromBase && cmp.base ? cmp.base : cmp.left;
      // A change of the working tree can go back to the left side.
      d.setRevert(
        worktree
          ? async (p, text, expected) => {
              if (await cb.writeFile(p, text, expected)) await reload(p);
            }
          : null,
      );
      const fileMenu = (c: Change, e: MouseEvent) => {
        e.preventDefault();
        const paths = c.old_path && c.old_path !== c.path ? [c.path, c.old_path] : [c.path];
        showMenu(e.clientX, e.clientY, [
          {
            label: `Revert to ${leftName}…`,
            disabled: !worktree,
            action: async () => {
              if (await cb.revertFiles(leftRev, leftName, paths)) await reload(c.path);
            },
          },
          { label: "Open in Editor", disabled: !worktree || c.status === "D", action: () => cb.openInEditor(c.path) },
          { separator: true },
          { label: "Copy Path", action: () => cb.copyText(c.path) },
        ]);
      };
      files = await cb.changes(l, r);
      if (req !== request) return;
      d.setSides(fromBase ? `common ancestor ${cmp.base?.slice(0, 8) ?? "(none)"}` : left, rightName);
      summary.textContent = `${files.length} file${files.length === 1 ? "" : "s"}`;
      filesEl.replaceChildren(
        ...files.map((c, i) => {
          const slash = c.path.lastIndexOf("/");
          const row = h(
            "div",
            { class: "history-row compare-file", title: c.old_path ? `${c.old_path} → ${c.path}` : c.path },
            h("span", { class: `status status-${c.status}`, title: statusName(c.status) }, c.status),
            h("span", { class: "rebase-subject" }, c.path.slice(slash + 1)),
            h("span", { class: "rebase-author" }, slash > 0 ? c.path.slice(0, slash) : ""),
          );
          row.addEventListener("mousedown", (e) => e.button === 0 && void select(i));
          row.addEventListener("contextmenu", (e) => {
            void select(i);
            fileMenu(c, e);
          });
          return row;
        }),
      );
      selected = -1;
      const first = path ? files.findIndex((f) => f.path === path) : -1;
      path = undefined;
      if (files.length) void select(Math.max(0, first));
      else d.message(fromBase ? `${rightName} has no file changes since the common ancestor.` : "The two sides have the same files.");
    } catch (e) {
      if (req === request) {
        commitsEl.replaceChildren(h("div", { class: "settings-hint error" }, String(e).replace(/^Error: /, "")));
        d.message("");
      }
    }
  };

  /** Loads the files again after a revert, and shows the same file when it still differs. */
  const reload = async (p: string) => {
    path = p;
    await load();
  };

  leftSel.addEventListener("change", () => {
    left = leftSel.value;
    void load();
  });
  rightSel.addEventListener("change", () => {
    right = rightSel.value;
    void load();
  });
  mode.addEventListener("change", () => {
    fromBase = mode.value === "base";
    void load();
  });
  swap.addEventListener("click", () => {
    if (right === WORKTREE) return;
    [left, right] = [right, left];
    void load();
  });
  await load();
}
