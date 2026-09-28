// Stash tab: the stashes of the repository, newest first.

import type { Stash } from "./api";
import { formatDate, h } from "./dom";

export class StashPanel {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private stashes: Stash[] = [];
  private selected: number | null = null;
  onSelect: (s: Stash) => void = () => {};
  onMenu: (s: Stash, e: MouseEvent) => void = () => {};
  onStashAll: () => void = () => {};
  onRefresh: () => void = () => {};

  constructor() {
    const stash = h("button", { class: "tb-button stash-all", title: "Stash all local changes" }, "Stash Changes…");
    stash.addEventListener("click", () => this.onStashAll());
    const refresh = h("button", { class: "icon-button", title: "Refresh" }, "⟳");
    refresh.addEventListener("click", () => this.onRefresh());
    this.list = h("div", { class: "stash-list", tabIndex: 0 });
    this.list.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      if (!this.stashes.length) return;
      const i = this.selected === null ? 0 : Math.max(0, Math.min(this.stashes.length - 1, this.selected + (e.key === "ArrowDown" ? 1 : -1)));
      this.select(i);
    });
    this.el = h("section", { class: "stash-panel" }, h("div", { class: "commit-toolbar" }, refresh, h("span", { class: "spacer" }), stash), this.list);
    this.render();
  }

  get count() {
    return this.stashes.length;
  }

  set(stashes: Stash[]) {
    const keep = this.selected !== null ? this.stashes[this.selected]?.oid : undefined;
    this.stashes = stashes;
    const i = keep ? stashes.findIndex((s) => s.oid === keep) : -1;
    this.selected = i >= 0 ? i : null;
    this.render();
  }

  clearSelection() {
    this.selected = null;
    this.render();
  }

  private select(i: number) {
    this.selected = i;
    this.render();
    this.list.querySelector(".stash-row.selected")?.scrollIntoView({ block: "nearest" });
    this.onSelect(this.stashes[i]);
  }

  private render() {
    if (!this.stashes.length) {
      this.list.replaceChildren(h("div", { class: "muted commit-empty" }, "There are no stashes. Stash local changes from here or from the Commit tab."));
      return;
    }
    this.list.replaceChildren(
      ...this.stashes.map((s, i) => {
        const row = h(
          "div",
          { class: "stash-row" + (i === this.selected ? " selected" : ""), title: s.oid },
          h("div", { class: "stash-message" }, s.message || "(no message)"),
          h(
            "div",
            { class: "stash-meta" },
            h("code", {}, `stash@{${s.index}}`),
            s.branch ? h("span", { class: "stash-branch" }, `⑂ ${s.branch}`) : "",
            h("span", {}, formatDate(s.time)),
          ),
        );
        row.addEventListener("mousedown", (e) => e.button === 0 && this.select(i));
        row.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          if (this.selected !== i) this.select(i);
          this.onMenu(s, e);
        });
        return row;
      }),
    );
  }
}
