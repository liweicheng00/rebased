// The Settings dialog: appearance, Git, the diff, Local History and the keymap. The dialog edits a copy
// of the settings; OK returns the copy and the caller applies it.

import { h } from "./dom";
import { eventKey, formatKey, type Keymap } from "./keymap";
import { settings, type Settings, type Theme } from "./settings";

export interface SettingsContext {
  keymap: Keymap;
  /** Checks a git program and returns its version. It throws when the program is not git. */
  testGit: (path: string) => Promise<string>;
  pickFile: () => Promise<string | null>;
}

type Page = "general" | "git" | "commit" | "diff" | "history" | "keymap";

export function openSettingsDialog(ctx: SettingsContext): Promise<Settings | null> {
  const draft: Settings = structuredClone(settings);
  return new Promise((resolve) => {
    const close = (v: Settings | null) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(v);
    };
    /** The action whose key the dialog waits for. */
    let recording: { id: string; index: number } | null = null;
    const onKey = (e: KeyboardEvent) => {
      if (recording) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape") {
          recording = null;
          render();
          return;
        }
        const key = eventKey(e);
        if (!key) return;
        const keys = [...ctx.keymap.keysOf(recording.id)];
        const cur = draft.keymap[recording.id] ?? keys;
        const next = [...cur];
        next[recording.index] = key;
        draft.keymap[recording.id] = next;
        recording = null;
        render();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        close(null);
      }
    };

    const nav = h("nav", { class: "settings-nav" });
    const content = h("div", { class: "settings-content" });
    const pages: [Page, string][] = [
      ["general", "General"],
      ["git", "Git"],
      ["commit", "Commit"],
      ["diff", "Diff"],
      ["history", "Local History"],
      ["keymap", "Keymap"],
    ];
    let page: Page = "general";

    const row = (label: string, control: Node, hint = "") =>
      h("label", { class: "settings-row" }, h("span", { class: "settings-label" }, label), h("div", { class: "settings-control" }, control, hint ? h("div", { class: "settings-hint" }, hint) : ""));
    const check = (label: string, get: () => boolean, set: (v: boolean) => void) => {
      const box = h("input", { type: "checkbox", checked: get() });
      box.addEventListener("change", () => set(box.checked));
      return h("label", { class: "dialog-check" }, box, label);
    };
    const select = <T extends string>(options: [T, string][], get: () => T, set: (v: T) => void) => {
      const el = h("select", { class: "dialog-input" }, ...options.map(([v, l]) => h("option", { value: v, selected: get() === v }, l)));
      el.addEventListener("change", () => set(el.value as T));
      return el;
    };
    const number = (get: () => number, set: (v: number) => void, min: number, max: number) => {
      const el = h("input", { class: "dialog-input settings-number", type: "number", min: String(min), max: String(max), value: String(get()) });
      el.addEventListener("change", () => {
        const v = Math.round(Number(el.value));
        if (Number.isFinite(v)) set(Math.max(min, Math.min(max, v)));
        el.value = String(get());
      });
      return el;
    };
    const text = (get: () => string, set: (v: string) => void, placeholder: string) => {
      const el = h("input", { class: "dialog-input", type: "text", value: get(), placeholder, spellcheck: false });
      el.addEventListener("input", () => set(el.value));
      return el;
    };

    const general = () => [
      row("Theme", select<Theme>([["system", "Same as the system"], ["light", "Light"], ["dark", "Dark"]], () => draft.theme, (v) => (draft.theme = v))),
      row("Update", select<"merge" | "rebase">([["merge", "Merge the tracked branch"], ["rebase", "Rebase onto the tracked branch"]], () => draft.updateMode, (v) => (draft.updateMode = v)), "The default of the Update dialog."),
      row("Refresh", check("Refresh when files or refs change outside the app", () => draft.autoRefresh, (v) => (draft.autoRefresh = v))),
      row("Auto fetch", h("span", { class: "settings-inline" }, "Every ", number(() => draft.autoFetchMinutes, (v) => (draft.autoFetchMinutes = v), 0, 1440), " minutes"), "0 turns it off. Fetch asks for a password when a remote needs one."),
    ];

    const git = () => {
      const status = h("span", { class: "settings-hint" }, "");
      const input = text(() => draft.gitPath, (v) => (draft.gitPath = v), "git (from PATH)");
      const test = h("button", {}, "Test");
      test.addEventListener("click", async (e) => {
        e.preventDefault();
        status.textContent = "Testing…";
        status.className = "settings-hint";
        try {
          status.textContent = `git ${await ctx.testGit(draft.gitPath)}`;
          status.className = "settings-hint ok";
        } catch (err) {
          status.textContent = String(err).replace(/^Error: /, "");
          status.className = "settings-hint error";
        }
      });
      const browse = h("button", {}, "Browse…");
      browse.addEventListener("click", async (e) => {
        e.preventDefault();
        const p = await ctx.pickFile();
        if (p) {
          draft.gitPath = p;
          input.value = p;
        }
      });
      return [
        row("Git executable", h("div", { class: "dialog-field-row" }, input, browse, test)),
        status,
        h("p", { class: "settings-hint" }, "Rebased Lite runs this program for all git commands. An empty field uses git from PATH."),
      ];
    };

    const commit = () => [
      row("Subject length", h("span", { class: "settings-inline" }, number(() => draft.subjectLimit, (v) => (draft.subjectLimit = v), 0, 500), " characters at most")),
      row("Body lines", h("span", { class: "settings-inline" }, number(() => draft.bodyLimit, (v) => (draft.bodyLimit = v), 0, 500), " characters at most")),
      row("", check("A blank line after the subject", () => draft.blankAfterSubject, (v) => (draft.blankAfterSubject = v))),
      row("Sign-off", check("Add Signed-off-by to new commits", () => draft.signOff, (v) => (draft.signOff = v))),
      h("p", { class: "settings-hint" }, "0 turns a length check off. The checks show below the message and ask before a commit. Comment lines (#) do not count. An empty message gets the file of commit.template."),
    ];

    const diff = () => [
      row("Font size", number(() => draft.diffFontSize, (v) => (draft.diffFontSize = v), 8, 32)),
      row("Font family", text(() => draft.diffFontFamily, (v) => (draft.diffFontFamily = v), "Default monospace font")),
      row("Layout", check("Side by side", () => draft.sideBySide, (v) => (draft.sideBySide = v))),
      row("", check("Ignore whitespace", () => draft.ignoreWhitespace, (v) => (draft.ignoreWhitespace = v))),
      row("", check("Collapse unchanged regions", () => draft.collapseUnchanged, (v) => (draft.collapseUnchanged = v))),
    ];

    const history = () => [
      row("Keep versions", h("span", { class: "settings-inline" }, number(() => draft.historyDays, (v) => (draft.historyDays = v), 1, 365), " days")),
      row("Size limit", h("span", { class: "settings-inline" }, number(() => draft.historyMaxMb, (v) => (draft.historyMaxMb = v), 10, 10000), " MB for each repository")),
      h("p", { class: "settings-hint" }, "Local History keeps versions of changed files in the git directory. Older versions are removed first."),
    ];

    const keymapPage = () => {
      const keysOf = (id: string) => draft.keymap[id] ?? ctx.keymap.actions.find((a) => a.id === id)!.defaults;
      const allKeys: Record<string, string[]> = {};
      for (const a of ctx.keymap.actions) allKeys[a.id] = keysOf(a.id);
      const conflicts = ctx.keymap.conflicts(allKeys);
      const rows = ctx.keymap.actions.map((a) => {
        const keys = keysOf(a.id);
        const chips = keys.map((k, i) => {
          const rec = recording?.id === a.id && recording.index === i;
          const chip = h("button", { class: "key-chip" + (conflicts.has(k) ? " conflict" : "") + (rec ? " recording" : ""), title: conflicts.has(k) ? "Another action has this key" : "Click, then press the new key" }, rec ? "Press a key…" : formatKey(k));
          chip.addEventListener("click", (e) => {
            e.preventDefault();
            recording = { id: a.id, index: i };
            render();
          });
          const remove = h("button", { class: "icon-button key-remove", title: "Remove this key" }, "✕");
          remove.addEventListener("click", (e) => {
            e.preventDefault();
            draft.keymap[a.id] = keys.filter((_, j) => j !== i);
            render();
          });
          return h("span", { class: "key-item" }, chip, remove);
        });
        const add = h("button", { class: "icon-button", title: "Add a key" }, "+");
        add.addEventListener("click", (e) => {
          e.preventDefault();
          draft.keymap[a.id] = [...keys, ""];
          recording = { id: a.id, index: keys.length };
          render();
        });
        const changed = draft.keymap[a.id] !== undefined;
        const reset = h("button", { class: "icon-button", title: "Use the default keys", disabled: !changed }, "↺");
        reset.addEventListener("click", (e) => {
          e.preventDefault();
          delete draft.keymap[a.id];
          render();
        });
        return h("div", { class: "keymap-row" + (changed ? " changed" : "") }, h("span", { class: "keymap-label" }, a.label), h("span", { class: "keymap-keys" }, ...chips, add), reset);
      });
      const resetAll = h("button", {}, "Reset All Keys");
      resetAll.addEventListener("click", (e) => {
        e.preventDefault();
        draft.keymap = {};
        render();
      });
      return [h("div", { class: "keymap-list" }, ...rows), h("div", { class: "dialog-field-row" }, resetAll, conflicts.size ? h("span", { class: "settings-hint error" }, `${conflicts.size} key(s) are used by more than one action. The first action in the list wins.`) : "")];
    };

    const render = () => {
      nav.replaceChildren(
        ...pages.map(([id, label]) => {
          const b = h("button", { class: "settings-page" + (id === page ? " on" : "") }, label);
          b.addEventListener("click", () => {
            page = id;
            recording = null;
            render();
          });
          return b;
        }),
      );
      const body = { general, git, commit, diff, history, keymap: keymapPage }[page]();
      content.replaceChildren(h("h3", { class: "settings-title" }, pages.find((p) => p[0] === page)![1]), ...body);
    };

    const ok = h("button", { class: "primary" }, "OK");
    ok.addEventListener("click", () => {
      // An unfinished new key is dropped.
      for (const [id, keys] of Object.entries(draft.keymap)) draft.keymap[id] = keys.filter(Boolean);
      close(draft);
    });
    const cancel = h("button", {}, "Cancel");
    cancel.addEventListener("click", () => close(null));
    const dialog = h(
      "div",
      { class: "dialog wide settings-dialog", role: "dialog", "aria-modal": "true", "aria-label": "Settings" },
      h("div", { class: "dialog-title" }, "Settings"),
      h("div", { class: "settings-body" }, nav, content),
      h("div", { class: "dialog-buttons" }, cancel, ok),
    );
    const overlay = h("div", { class: "overlay" }, dialog);
    overlay.addEventListener("mousedown", (e) => e.target === overlay && close(null));
    document.body.append(overlay);
    document.addEventListener("keydown", onKey, true);
    render();
  });
}
