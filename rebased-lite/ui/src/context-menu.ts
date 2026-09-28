// A popup menu for right-click and toolbar dropdowns.

import { h } from "./dom";

export type MenuItem =
  | { label: string; action: () => void; disabled?: boolean; shortcut?: string; checked?: boolean }
  | { separator: true }
  | { header: string };

let current: HTMLElement | null = null;

export function closeMenu() {
  current?.remove();
  current = null;
}

export function showMenu(x: number, y: number, items: MenuItem[]) {
  closeMenu();
  const menu = h("div", { class: "menu", role: "menu" });
  for (const item of items) {
    if ("separator" in item) {
      menu.append(h("div", { class: "menu-sep" }));
    } else if ("header" in item) {
      menu.append(h("div", { class: "menu-header" }, item.header));
    } else {
      const el = h(
        "button",
        { class: "menu-item", role: "menuitem", disabled: item.disabled },
        h("span", { class: "menu-check" }, item.checked === undefined ? "" : item.checked ? "✓" : ""),
        h("span", { class: "menu-label" }, item.label),
        h("span", { class: "menu-shortcut" }, item.shortcut ?? ""),
      );
      el.addEventListener("click", () => {
        closeMenu();
        item.action();
      });
      menu.append(el);
    }
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
  current = menu;
}

export function menuBelow(anchor: HTMLElement, items: MenuItem[]) {
  const r = anchor.getBoundingClientRect();
  showMenu(r.left, r.bottom + 2, items);
}

window.addEventListener("mousedown", (e) => {
  if (current && !current.contains(e.target as Node)) closeMenu();
});
window.addEventListener("keydown", (e) => e.key === "Escape" && closeMenu());
window.addEventListener("blur", closeMenu);
