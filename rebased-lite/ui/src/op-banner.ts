// A banner above the log while a merge, rebase, cherry-pick or revert waits for conflict resolution.

import type { RepoState } from "./api";
import { h } from "./dom";

export class OpBanner {
  readonly el: HTMLElement;
  onContinue: () => void = () => {};
  onAbort: () => void = () => {};
  onMarkResolved: (paths: string[]) => void = () => {};
  onShowFile: (path: string) => void = () => {};
  onResolve: () => void = () => {};

  constructor() {
    this.el = h("div", { class: "op-banner", hidden: true, role: "alert" });
  }

  update(state: RepoState | null) {
    // Conflicts without an operation come from a stash apply or pop.
    if (!state || (state.operation === "none" && state.conflicts.length === 0)) {
      this.el.hidden = true;
      return;
    }
    const op = state.operation === "none" ? null : state.operation;
    const name = op ? { merge: "Merge", rebase: "Rebase", "cherry-pick": "Cherry-pick", revert: "Revert" }[op] : null;
    const cont = h("button", { class: "primary", disabled: state.conflicts.length > 0 }, "Continue");
    const abort = h("button", {}, "Abort");
    const resolve = h("button", { disabled: state.conflicts.length === 0, title: "Stage the conflicted files after you fixed them in your editor" }, "Mark Resolved");
    const resolveAll = h("button", { class: "primary", title: "Resolve the conflicts in the merge window" }, "Resolve…");
    resolveAll.addEventListener("click", () => this.onResolve());
    cont.addEventListener("click", () => this.onContinue());
    abort.addEventListener("click", () => this.onAbort());
    resolve.addEventListener("click", () => this.onMarkResolved(state.conflicts));
    const files = h(
      "div",
      { class: "op-files" },
      ...state.conflicts.map((p) => {
        const a = h("a", { href: "#", class: "op-file", title: "Open the merge window for this file" }, p);
        a.addEventListener("click", (e) => {
          e.preventDefault();
          this.onShowFile(p);
        });
        return a;
      }),
    );
    this.el.replaceChildren(
      h(
        "div",
        { class: "op-row" },
        h("b", {}, name ? `${name} in progress` : "Unresolved conflicts"),
        h(
          "span",
          { class: "muted-inline" },
          !name
            ? `${state.conflicts.length} file(s) have conflicts. Fix them, then mark them resolved.`
            : state.editing && !state.conflicts.length
              ? `Stopped at ${state.editing.slice(0, 8)} for editing. Change the files, amend the commit in the Commit tab, then continue.`
              : state.conflicts.length
              ? `${state.conflicts.length} file(s) have conflicts. Fix them in your editor, mark them resolved, then continue.`
              : "No conflicts are left. Continue to finish.",
        ),
        h("span", { class: "spacer" }),
        state.conflicts.length ? resolveAll : "",
        resolve,
        name ? abort : "",
        name ? cont : "",
      ),
      state.conflicts.length ? files : "",
    );
    this.el.hidden = false;
  }
}
