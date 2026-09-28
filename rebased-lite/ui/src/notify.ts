// Toast notifications in the lower-right corner, with an optional action such as Undo.

import { h } from "./dom";

const host = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
document.body.append(host);

export function toast(message: string, kind: "info" | "success" | "error" = "info", action?: { label: string; run: () => void }, ms = 7000) {
  const close = h("button", { class: "icon-button", title: "Close" }, "✕");
  const el = h("div", { class: `toast toast-${kind}` }, h("span", { class: "toast-text" }, message));
  if (action) {
    const b = h("button", { class: "toast-action" }, action.label);
    b.addEventListener("click", () => {
      el.remove();
      action.run();
    });
    el.append(b);
  }
  el.append(close);
  close.addEventListener("click", () => el.remove());
  host.append(el);
  if (kind !== "error") setTimeout(() => el.remove(), action ? ms * 2 : ms);
}
