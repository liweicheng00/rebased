// Reviews tab: the local reviews of the repository, to switch between them fast.

import type { ReviewSummary } from "./api";
import { formatDate, h } from "./dom";

export class ReviewPanel {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private reviews: ReviewSummary[] = [];
  onOpen: (r: ReviewSummary) => void = () => {};
  onMenu: (r: ReviewSummary, e: MouseEvent) => void = () => {};
  onNew: () => void = () => {};
  onFinish: (r: ReviewSummary) => void = () => {};

  constructor() {
    const add = h("button", { class: "tb-button", title: "Review a branch" }, "New Review…");
    add.addEventListener("click", () => this.onNew());
    this.list = h("div", { class: "review-list", tabIndex: 0 });
    this.el = h("section", { class: "review-panel" }, h("div", { class: "commit-toolbar" }, h("span", { class: "spacer" }), add), this.list);
    this.render();
  }

  /** The reviews that are not merged yet. */
  get open() {
    return this.reviews.filter((r) => r.exists && !r.merged).length;
  }

  get all() {
    return this.reviews;
  }

  set(reviews: ReviewSummary[]) {
    this.reviews = reviews;
    this.render();
  }

  private render() {
    if (!this.reviews.length) {
      this.list.replaceChildren(
        h("div", { class: "muted commit-empty" }, "There are no reviews. Right-click a branch and choose Review Branch, or click New Review."),
      );
      return;
    }
    this.list.replaceChildren(
      ...this.reviews.map((r) => {
        const state = r.merged
          ? h("span", { class: "review-badge merged" }, "merged")
          : !r.exists
            ? h("span", { class: "review-badge gone" }, "branch gone")
            : r.conflicts.length
              ? h("span", { class: "review-badge conflict", title: r.conflicts.join("\n") }, `⚠ ${r.conflicts.length} conflict${r.conflicts.length === 1 ? "" : "s"}`)
              : h("span", { class: "review-badge ready" }, "no conflicts");
        const done = r.files ? Math.round((r.viewed / r.files) * 100) : 0;
        const finish = h("button", { class: "review-finish", title: `Merge ${r.branch} into ${r.base}`, disabled: !r.exists || r.merged || r.baseIsRemote }, "Merge…");
        if (r.baseIsRemote) finish.title = `${r.base} is a remote branch. Merge needs a local base`;
        finish.addEventListener("click", (e) => {
          e.stopPropagation();
          this.onFinish(r);
        });
        const row = h(
          "div",
          { class: "review-row", title: `${r.branch} → ${r.base}\n${r.subject}` },
          h("div", { class: "review-title" }, h("b", {}, r.branch), h("span", { class: "muted-inline" }, ` → ${r.base}`), h("span", { class: "spacer" }), finish),
          h(
            "div",
            { class: "review-meta" },
            r.exists ? h("span", {}, `${r.commits} commit${r.commits === 1 ? "" : "s"}`) : "",
            r.behind ? h("span", { title: `${r.base} has ${r.behind} commit(s) that ${r.branch} does not have` }, `${r.behind} behind`) : "",
            r.exists ? h("span", {}, `${r.viewed}/${r.files} viewed`) : "",
            r.comments ? h("span", {}, `💬 ${r.comments}`) : "",
            state,
          ),
          r.exists && h("div", { class: "review-progress" }, h("div", { class: "review-progress-bar", style: { width: `${done}%` } })),
          r.time ? h("div", { class: "review-meta" }, h("span", { class: "review-subject" }, r.subject), h("span", {}, formatDate(r.time))) : "",
        );
        row.addEventListener("click", () => this.onOpen(r));
        row.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          this.onMenu(r, e);
        });
        return row;
      }),
    );
  }
}
