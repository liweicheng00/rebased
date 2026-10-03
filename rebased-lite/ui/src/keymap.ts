// The keymap: the app-wide actions and their keys. The settings can change the keys of each action.
//
// A key is written as modifiers and a key name joined by "+", for example "Mod+Shift+K" or "F7". "Mod" is
// Ctrl, or Cmd on macOS. Letters and digits use their physical key, so Shift does not change them.

import { settings } from "./settings";

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

export interface KeyAction {
  id: string;
  label: string;
  /** The keys without user changes. */
  defaults: string[];
  run: () => void;
  /** False: the key does nothing here and keeps its normal meaning, for example Copy in a text field. */
  when?: (target: HTMLElement) => boolean;
}

/** The key of a keyboard event, or null for a modifier alone. */
export function eventKey(e: KeyboardEvent): string | null {
  if (["Control", "Meta", "Alt", "Shift"].includes(e.key)) return null;
  let key: string;
  if (e.code.startsWith("Key")) key = e.code.slice(3);
  else if (e.code.startsWith("Digit")) key = e.code.slice(5);
  else if (e.key === " ") key = "Space";
  else if (e.key === ",") key = "Comma";
  // The key left of 1, by its place: e.key differs between keyboard layouts.
  else if (e.code === "Backquote") key = "`";
  else key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  const parts: string[] = [];
  if (isMac ? e.metaKey : e.ctrlKey) parts.push("Mod");
  if (isMac && e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

/** The key as the user sees it, for example "Ctrl+Shift+K" or "⌘⇧K". */
export function formatKey(key: string): string {
  const names: Record<string, string> = isMac
    ? { Mod: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧", ArrowUp: "↑", ArrowDown: "↓", PageUp: "⇞", PageDown: "⇟", Comma: "," }
    : { Mod: "Ctrl", ArrowUp: "Up", ArrowDown: "Down", Comma: "," };
  const parts = key.split("+").map((p) => names[p] ?? p);
  return isMac ? parts.join("") : parts.join("+");
}

export class Keymap {
  readonly actions: KeyAction[] = [];

  add(a: KeyAction) {
    this.actions.push(a);
  }

  /** The keys of an action: the user's keys when set, else the defaults. */
  keysOf(id: string): string[] {
    return settings.keymap[id] ?? this.actions.find((a) => a.id === id)?.defaults ?? [];
  }

  /** The key of an action for menus and tooltips, or "" when it has none. */
  shortcut(id: string): string {
    const k = this.keysOf(id)[0];
    return k ? formatKey(k) : "";
  }

  /** Runs the action of a key. Returns true when an action ran. */
  handle(e: KeyboardEvent): boolean {
    const key = eventKey(e);
    if (!key) return false;
    const target = e.target as HTMLElement;
    for (const a of this.actions) {
      if (!this.keysOf(a.id).includes(key)) continue;
      if (a.when && !a.when(target)) continue;
      e.preventDefault();
      a.run();
      return true;
    }
    return false;
  }

  /** The actions that share a key with another action, by key. */
  conflicts(keys: Record<string, string[]>): Map<string, string[]> {
    const byKey = new Map<string, string[]>();
    for (const a of this.actions) for (const k of keys[a.id] ?? a.defaults) byKey.set(k, [...(byKey.get(k) ?? []), a.id]);
    return new Map([...byKey].filter(([, ids]) => ids.length > 1));
  }
}
