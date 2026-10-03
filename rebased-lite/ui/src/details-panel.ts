// Commit details: message, hash, author, committer, parents and refs.

import { api, type CommitInfo, type Row, type TagInfo } from "./api";
import { copyText, formatDate, h } from "./dom";

export class DetailsPanel {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private request = 0;
  onJump: (oid: string) => void = () => {};

  constructor() {
    this.body = h("div", { class: "details-body" });
    this.el = h("section", { class: "details-panel" }, h("div", { class: "pane-title" }, "Commit Details"), this.body);
    this.clear();
  }

  clear() {
    this.body.replaceChildren(h("div", { class: "muted" }, "No commit selected."));
  }

  async show(rows: Row[]) {
    const req = ++this.request;
    if (rows.length === 0) return this.clear();
    if (rows.length > 1) {
      this.body.replaceChildren(
        h("div", { class: "details-multi" }, `${rows.length} commits selected`),
        ...rows.map((r) =>
          h(
            "div",
            { class: "details-multi-row" },
            this.hashLink(r.oid),
            h("span", { class: "details-multi-subject" }, r.subject),
            h("span", { class: "muted-inline" }, `${r.author} · ${formatDate(r.authorTime)}`),
          ),
        ),
      );
      return;
    }
    try {
      const c = await api.commit(rows[0].oid);
      if (req === this.request) this.render(c);
    } catch (e) {
      if (req === this.request) this.body.replaceChildren(h("div", { class: "error" }, String(e)));
    }
  }

  private hashLink(oid: string): HTMLElement {
    const a = h("a", { class: "hash-link", href: "#", title: "Go to this commit" }, oid.slice(0, 10));
    a.addEventListener("click", (e) => {
      e.preventDefault();
      this.onJump(oid);
    });
    return a;
  }

  /** The details of the tags of the commit: the message of an annotated tag, its tagger and date. */
  private async loadTags(names: string[], out: HTMLElement, req: number) {
    const infos = await Promise.all(names.map((n) => api.tagInfo(n).catch(() => null)));
    if (req !== this.request) return;
    out.replaceChildren(
      ...infos
        .filter((t): t is TagInfo => !!t)
        .map((t) =>
          h(
            "div",
            { class: "tag-card" },
            h(
              "div",
              { class: "tag-card-head" },
              h("span", { class: "ref ref-tag" }, t.name),
              t.annotated ? "" : h("span", { class: "muted-inline" }, "lightweight tag"),
              t.signed ? h("span", { class: "tag-signed", title: "The tag has a signature. Rebased Lite does not check it." }, "signed") : "",
            ),
            t.annotated
              ? h("div", { class: "muted-inline tag-card-meta" }, `${t.tagger} <${t.taggerEmail}> · ${formatDate(t.time)}`)
              : "",
            t.subject ? h("div", { class: "tag-card-subject" }, t.subject) : "",
            t.body ? h("pre", { class: "details-message tag-card-body" }, t.body) : "",
          ),
        ),
    );
  }

  private render(c: CommitInfo) {
    const copy = h("button", { class: "icon-button", title: "Copy the full hash" }, "⧉");
    copy.addEventListener("click", () => void copyText(c.oid));
    const refs = c.refs.length ? h("div", { class: "details-refs" }, ...c.refs.map((r) => h("span", { class: `ref ref-${r.kind}` }, r.name))) : "";
    const sameCommitter = c.committer === c.author && c.committer_email === c.author_email;
    const tags = c.refs.filter((r) => r.kind === "tag").map((r) => r.name);
    const tagCards = h("div", { class: "tag-cards" });
    if (tags.length) void this.loadTags(tags, tagCards, this.request);
    this.body.replaceChildren(
      refs,
      tagCards,
      h("div", { class: "details-subject" }, c.subject),
      c.body ? h("pre", { class: "details-message" }, c.body) : "",
      h(
        "dl",
        { class: "details-meta" },
        h("dt", {}, "Hash"),
        h("dd", {}, h("code", {}, c.oid), " ", copy),
        h("dt", {}, "Author"),
        h("dd", {}, `${c.author} <${c.author_email}>`, h("div", { class: "muted-inline" }, formatDate(c.author_time))),
        !sameCommitter || c.commit_time !== c.author_time ? h("dt", {}, "Committer") : "",
        !sameCommitter || c.commit_time !== c.author_time
          ? h("dd", {}, `${c.committer} <${c.committer_email}>`, h("div", { class: "muted-inline" }, formatDate(c.commit_time)))
          : "",
        h("dt", {}, c.parents.length > 1 ? "Parents" : "Parent"),
        h("dd", {}, ...(c.parents.length ? c.parents.flatMap((p) => [this.hashLink(p), " "]) : ["none (root commit)"])),
      ),
    );
  }
}
