// Modal dialogs: forms, confirmations, the reset dialog, the message editor and the interactive rebase editor.

import type { PlanAction, PlanEntry, PushInfo, RewriteRange } from "./api";
import { formatDate, h } from "./dom";

interface DialogButton {
  label: string;
  primary?: boolean;
  danger?: boolean;
  value: string;
}

/** Shows a modal and resolves with the value of the clicked button, or null on Escape or Cancel. */
function modal(title: string, body: Node[], buttons: DialogButton[], wide = false): Promise<string | null> {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement as HTMLElement | null;
    const close = (v: string | null) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
      prevFocus?.focus();
      resolve(v);
    };
    const primary = buttons.find((b) => b.primary) ?? buttons[buttons.length - 1];
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(null);
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey || (e.target as HTMLElement).tagName !== "TEXTAREA")) {
        if ((e.target as HTMLElement).tagName === "SELECT" || (e.target as HTMLElement).tagName === "BUTTON") return;
        e.preventDefault();
        close(primary.value);
      }
    };
    const cancel = h("button", {}, "Cancel");
    cancel.addEventListener("click", () => close(null));
    const btns = buttons.map((b) => {
      const el = h("button", { class: b.danger ? "danger" : b.primary ? "primary" : "" }, b.label);
      el.addEventListener("click", () => close(b.value));
      return el;
    });
    const dialog = h(
      "div",
      { class: "dialog" + (wide ? " wide" : ""), role: "dialog", "aria-modal": "true", "aria-label": title },
      h("div", { class: "dialog-title" }, title),
      ...body,
      h("div", { class: "dialog-buttons" }, cancel, ...btns),
    );
    const overlay = h("div", { class: "overlay" }, dialog);
    overlay.addEventListener("mousedown", (e) => e.target === overlay && close(null));
    document.body.append(overlay);
    document.addEventListener("keydown", onKey, true);
    (dialog.querySelector("input, textarea, select") as HTMLElement | null)?.focus();
    const first = dialog.querySelector("input[type=text], textarea") as HTMLInputElement | null;
    first?.select?.();
  });
}

export async function confirmDialog(title: string, message: string, okLabel: string, danger = false): Promise<boolean> {
  const r = await modal(title, [h("p", { class: "dialog-text" }, message)], [{ label: okLabel, value: "ok", primary: !danger, danger }]);
  return r === "ok";
}

export interface Field {
  key: string;
  label: string;
  type?: "text" | "checkbox" | "textarea";
  value?: string | boolean;
  placeholder?: string;
  browse?: () => Promise<string | null>;
}

/** A small form. Resolves with the field values, or null on Cancel. */
export async function formDialog(title: string, fields: Field[], okLabel: string, note?: string): Promise<Record<string, string | boolean> | null> {
  const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
  const rows = fields.map((f) => {
    if (f.type === "checkbox") {
      const input = h("input", { type: "checkbox", checked: !!f.value });
      inputs.set(f.key, input);
      return h("label", { class: "dialog-check" }, input, f.label);
    }
    const input =
      f.type === "textarea"
        ? h("textarea", { class: "dialog-input", rows: 6, placeholder: f.placeholder ?? "", spellcheck: false }, String(f.value ?? ""))
        : h("input", { class: "dialog-input", type: "text", value: String(f.value ?? ""), placeholder: f.placeholder ?? "", spellcheck: false });
    inputs.set(f.key, input);
    const browse = f.browse ? h("button", { class: "browse" }, "Browse…") : "";
    if (browse && f.browse) {
      const pick = f.browse;
      browse.addEventListener("click", async () => {
        const p = await pick();
        if (p) input.value = p;
      });
    }
    return h("label", { class: "dialog-field" }, h("span", {}, f.label), h("div", { class: "dialog-field-row" }, input, browse));
  });
  const body: Node[] = [...rows];
  if (note) body.push(h("p", { class: "dialog-note" }, note));
  const r = await modal(title, body, [{ label: okLabel, value: "ok", primary: true }]);
  if (r !== "ok") return null;
  const out: Record<string, string | boolean> = {};
  for (const f of fields) {
    const i = inputs.get(f.key)!;
    out[f.key] = f.type === "checkbox" ? (i as HTMLInputElement).checked : i.value;
  }
  return out;
}

export async function resetDialog(target: string, branch: string): Promise<"soft" | "mixed" | "hard" | "keep" | null> {
  const modes: [string, string, string][] = [
    ["soft", "Soft", "Keep all changes. The commits after the target become staged changes."],
    ["mixed", "Mixed", "Keep all changes as unstaged changes. This is the default of git reset."],
    ["keep", "Keep", "Discard the commits, but keep local changes. Stops if a local change would be lost."],
    ["hard", "Hard", "Discard the commits and all local changes. This cannot be undone for uncommitted work."],
  ];
  let chosen = "mixed";
  const list = h(
    "div",
    { class: "dialog-radios" },
    ...modes.map(([v, label, text]) => {
      const input = h("input", { type: "radio", name: "reset-mode", value: v, checked: v === chosen });
      input.addEventListener("change", () => (chosen = v));
      return h("label", { class: "dialog-radio" + (v === "hard" ? " danger-text" : "") }, input, h("b", {}, label), h("span", {}, text));
    }),
  );
  const r = await modal(`Reset ${branch} to ${target}`, [list], [{ label: "Reset", value: "ok", primary: true }]);
  return r === "ok" ? (chosen as "soft" | "mixed" | "hard" | "keep") : null;
}

/** Edits a commit message. */
export async function messageDialog(title: string, message: string, okLabel: string, note?: string): Promise<string | null> {
  const r = await formDialog(title, [{ key: "m", label: "Commit message", type: "textarea", value: message }], okLabel, note);
  const m = r ? String(r.m).trim() : "";
  return r && m ? m : null;
}

const ACTIONS: [PlanAction, string][] = [
  ["pick", "Pick"],
  ["reword", "Reword"],
  ["squash", "Squash"],
  ["fixup", "Fixup"],
  ["drop", "Drop"],
];

/**
 * The interactive rebase editor. Rows show newest first, like the log; the plan it returns is oldest first.
 */
export async function interactiveRebaseDialog(range: RewriteRange): Promise<PlanEntry[] | null> {
  interface Line {
    oid: string;
    subject: string;
    message: string;
    author: string;
    action: PlanAction;
    newMessage: string;
  }
  let lines: Line[] = range.entries.map((e) => ({ ...e, action: "pick" as PlanAction, newMessage: e.message })).reverse();
  const list = h("div", { class: "rebase-list" });
  const error = h("div", { class: "dialog-error" });
  const render = () => {
    list.replaceChildren(
      ...lines.map((l, i) => {
        const select = h("select", { class: "rebase-action" }, ...ACTIONS.map(([v, label]) => h("option", { value: v, selected: v === l.action }, label)));
        select.addEventListener("change", () => {
          l.action = select.value as PlanAction;
          render();
        });
        const up = h("button", { class: "icon-button", title: "Move up (newer)", disabled: i === 0 }, "↑");
        const down = h("button", { class: "icon-button", title: "Move down (older)", disabled: i === lines.length - 1 }, "↓");
        up.addEventListener("click", () => {
          [lines[i - 1], lines[i]] = [lines[i], lines[i - 1]];
          render();
        });
        down.addEventListener("click", () => {
          [lines[i + 1], lines[i]] = [lines[i], lines[i + 1]];
          render();
        });
        const row = h(
          "div",
          { class: `rebase-row action-${l.action}` },
          up,
          down,
          select,
          h("code", { class: "rebase-hash" }, l.oid.slice(0, 8)),
          h("span", { class: "rebase-subject" }, l.subject),
          h("span", { class: "rebase-author" }, l.author),
        );
        if (l.action === "reword") {
          const ta = h("textarea", { class: "dialog-input rebase-message", rows: 3, spellcheck: false }, l.newMessage);
          ta.addEventListener("input", () => (l.newMessage = ta.value));
          return h("div", {}, row, ta);
        }
        return row;
      }),
    );
  };
  render();
  const note = h(
    "p",
    { class: "dialog-note" },
    "The top row is the newest commit. Squash and Fixup join a commit into the commit below it. The rebase runs in memory: a conflict stops it before anything changes.",
  );
  const warn = range.published ? h("p", { class: "dialog-note danger-text" }, "Some of these commits are on a remote branch already. After the rebase you must force-push.") : "";
  for (;;) {
    const r = await modal(`Interactively rebase ${range.entries.length} commits`, [note, warn || h("span"), list, error], [{ label: "Start Rebasing", value: "ok", primary: true }], true);
    if (r !== "ok") return null;
    const plan = [...lines].reverse();
    const first = plan.find((l) => l.action !== "drop");
    if (first && (first.action === "squash" || first.action === "fixup")) {
      error.textContent = "The oldest kept commit cannot be squashed: there is no commit below it.";
      continue;
    }
    return plan.map((l) => ({ oid: l.oid, action: l.action, message: l.action === "reword" ? l.newMessage.trim() : undefined }));
  }
}

export interface PushChoice {
  remote: string;
  remoteBranch: string;
  force: boolean;
  setUpstream: boolean;
  tags: boolean;
}

/** The push dialog: the outgoing commits, the target, and the push options, as in IntelliJ. */
export async function pushDialog(info: PushInfo): Promise<PushChoice | null> {
  const remote = h("select", { class: "dialog-input push-remote" }, ...info.remotes.map((r) => h("option", { value: r, selected: r === info.remote }, r)));
  const target = h("input", { class: "dialog-input push-target", type: "text", value: info.remoteBranch, spellcheck: false });
  const badge = h("span", { class: "push-new", hidden: !info.newBranch }, "New");
  const commits = h(
    "div",
    { class: "push-commits" },
    ...(info.outgoing.length
      ? info.outgoing.map((c) =>
          h(
            "div",
            { class: "push-commit", title: c.oid },
            h("code", { class: "rebase-hash" }, c.oid.slice(0, 8)),
            h("span", { class: "rebase-subject" }, c.subject),
            h("span", { class: "rebase-author" }, c.author),
            h("span", { class: "rebase-author" }, formatDate(c.time)),
          ),
        )
      : [h("div", { class: "muted" }, info.newBranch ? "The branch has no commits that are not on the remote. The push creates the remote branch." : "There are no commits to push.")]),
  );
  const force = h("input", { type: "checkbox" });
  const tags = h("input", { type: "checkbox" });
  const upstream = h("input", { type: "checkbox", checked: !info.upstream });
  const warn = h(
    "p",
    { class: "dialog-note danger-text", hidden: info.behind === 0 },
    `${info.upstream ?? "The remote branch"} has ${info.behind} commit(s) that are not in ${info.branch}. Update the branch first, or force push.`,
  );
  const body = [
    h(
      "div",
      { class: "push-route" },
      h("b", {}, info.branch),
      h("span", { class: "muted-inline" }, "→"),
      remote,
      h("span", { class: "muted-inline" }, ":"),
      target,
      badge,
    ),
    commits,
    h("p", { class: "dialog-note" }, `${info.outgoing.length} commit(s) to push${info.outgoing.length >= 1000 ? " (the first 1000 are shown)" : ""}.`),
    warn,
    h(
      "div",
      { class: "push-options" },
      h("label", { class: "dialog-check" }, force, "Force push (with lease: it stops when the remote has commits you did not fetch)"),
      h("label", { class: "dialog-check" }, tags, "Push tags that point to the pushed commits"),
      h("label", { class: "dialog-check" }, upstream, "Set the remote branch as the tracked branch"),
    ),
  ];
  const r = await modal(`Push Commits to ${info.remote ?? "remote"}`, body, [{ label: "Push", value: "ok", primary: true }], true);
  if (r !== "ok" || !remote.value || !target.value.trim()) return null;
  return { remote: remote.value, remoteBranch: target.value.trim(), force: force.checked, setUpstream: upstream.checked, tags: tags.checked };
}

/** Asks how Update merges the incoming commits. */
export async function updateDialog(branch: string, upstream: string | null, mode: "merge" | "rebase"): Promise<"merge" | "rebase" | null> {
  let chosen = mode;
  const modes: ["merge" | "rebase", string, string][] = [
    ["merge", "Merge", "Merge the incoming commits into the local branch."],
    ["rebase", "Rebase", "Rebase the local commits onto the incoming commits. The history stays linear."],
  ];
  const list = h(
    "div",
    { class: "dialog-radios" },
    ...modes.map(([v, label, text]) => {
      const input = h("input", { type: "radio", name: "update-mode", value: v, checked: v === chosen });
      input.addEventListener("change", () => (chosen = v));
      return h("label", { class: "dialog-radio" }, input, h("b", {}, label), h("span", {}, text));
    }),
  );
  const note = h("p", { class: "dialog-note" }, `Git fetches ${upstream ?? "the tracked branch"} first. Local changes are stashed and restored.`);
  const r = await modal(`Update ${branch}`, [list, note], [{ label: "Update", value: "ok", primary: true }]);
  return r === "ok" ? chosen : null;
}
