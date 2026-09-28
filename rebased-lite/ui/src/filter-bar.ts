// Filter bar above the log: text or hash, author, path, date and branches.

import type { LogFilter } from "./api";
import { menuBelow } from "./context-menu";
import { h } from "./dom";

export const DATE_OPTIONS: [string, string][] = [
  ["", "Any date"],
  ["1.day", "Last 24 hours"],
  ["1.week", "Last 7 days"],
  ["1.month", "Last 30 days"],
  ["3.months", "Last 3 months"],
  ["1.year", "Last year"],
];

export function emptyFilter(): LogFilter {
  return { branches: [], author: "", text: "", path: "", since: "" };
}

export class FilterBar {
  readonly el: HTMLElement;
  readonly text: HTMLInputElement;
  private author: HTMLInputElement;
  private path: HTMLInputElement;
  private since: HTMLButtonElement;
  private branchBtn: HTMLButtonElement;
  private clear: HTMLButtonElement;
  private info: HTMLElement;
  private authors: HTMLDataListElement;
  private value: LogFilter = emptyFilter();
  private timer = 0;
  branchNames: string[] = [];
  onChange: (f: LogFilter) => void = () => {};
  /** Called on Enter in the text box; returns true when the text was a commit that the log jumped to. */
  onJump: (query: string) => Promise<boolean> = async () => false;

  constructor() {
    this.text = h("input", { class: "filter-text", placeholder: "Text or hash", spellcheck: false, type: "search" });
    this.authors = h("datalist", { id: "authors" });
    this.author = h("input", { class: "filter-author", placeholder: "User", spellcheck: false, type: "search" });
    this.author.setAttribute("list", "authors");
    this.path = h("input", { class: "filter-path", placeholder: "Path", spellcheck: false, type: "search" });
    this.since = h("button", { class: "filter-button" }, "Date: Any");
    this.branchBtn = h("button", { class: "filter-button" }, "Branch: All");
    this.clear = h("button", { class: "filter-clear", title: "Clear all filters", hidden: true }, "✕ Clear");
    this.info = h("span", { class: "filter-info" });
    for (const input of [this.text, this.author, this.path]) {
      input.addEventListener("input", () => this.debounce());
    }
    this.text.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter") return;
      clearTimeout(this.timer);
      const q = this.text.value.trim();
      if (/^[0-9a-f]{4,40}$/i.test(q) && (await this.onJump(q))) {
        this.text.value = "";
        this.update({ text: "" });
        return;
      }
      this.update({ text: q });
    });
    this.since.addEventListener("click", () =>
      menuBelow(this.since, DATE_OPTIONS.map(([v, label]) => ({ label, checked: this.value.since === v, action: () => this.update({ since: v }) }))),
    );
    this.branchBtn.addEventListener("click", () => this.branchMenu());
    this.clear.addEventListener("click", () => this.set(emptyFilter(), true));
    this.el = h("div", { class: "filter-bar" }, this.text, this.branchBtn, this.author, this.authors, this.path, this.since, this.clear, this.info);
  }

  private debounce() {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.update({ text: this.text.value.trim(), author: this.author.value.trim(), path: this.path.value.trim() });
    }, 500);
  }

  private branchMenu() {
    const items = [
      { label: "All branches", checked: this.value.branches.length === 0, action: () => this.update({ branches: [] }) },
      { separator: true as const },
      ...this.branchNames.slice(0, 60).map((name) => ({
        label: name,
        checked: this.value.branches.includes(name),
        action: () => this.toggleBranch(name),
      })),
    ];
    menuBelow(this.branchBtn, items);
  }

  toggleBranch(name: string) {
    const b = this.value.branches.includes(name) ? this.value.branches.filter((x) => x !== name) : [...this.value.branches, name];
    this.update({ branches: b });
  }

  setAuthors(names: string[]) {
    this.authors.replaceChildren(...names.slice(0, 200).map((n) => h("option", { value: n })));
  }

  get filter(): LogFilter {
    return this.value;
  }

  private update(part: Partial<LogFilter>) {
    const next = { ...this.value, ...part };
    if (JSON.stringify(next) === JSON.stringify(this.value)) return;
    this.set(next, true);
  }

  set(f: LogFilter, notify: boolean) {
    this.value = f;
    if (this.text.value.trim() !== f.text) this.text.value = f.text;
    if (this.author.value.trim() !== f.author) this.author.value = f.author;
    if (this.path.value.trim() !== f.path) this.path.value = f.path;
    this.since.textContent = `Date: ${DATE_OPTIONS.find(([v]) => v === f.since)?.[1] ?? f.since}`.replace("Any date", "Any");
    this.since.classList.toggle("active", !!f.since);
    const include = f.branches.filter((b) => !b.startsWith("^"));
    const exclude = f.branches.filter((b) => b.startsWith("^")).map((b) => b.slice(1));
    this.branchBtn.textContent =
      f.branches.length === 0
        ? "Branch: All"
        : exclude.length
          ? `${include.join(", ") || "All"} not in ${exclude.join(", ")}`
          : `Branch: ${f.branches.length === 1 ? f.branches[0] : `${f.branches.length} selected`}`;
    this.branchBtn.classList.toggle("active", f.branches.length > 0);
    this.clear.hidden = !(f.branches.length || f.author || f.text || f.path || f.since);
    if (notify) this.onChange(f);
  }

  setInfo(text: string) {
    this.info.textContent = text;
  }
}
