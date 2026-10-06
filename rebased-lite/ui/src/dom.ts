// Small DOM helpers.

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k in el && k !== "list") (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/** The place and the time of the last mouse press, for the copy hint. */
let lastPress = { x: 0, y: 0, time: 0 };
window.addEventListener("mousedown", (e) => (lastPress = { x: e.clientX, y: e.clientY, time: Date.now() }), true);

/** A short hint that the text is on the clipboard: next to the mouse after a click, else at the bottom of
 * the window after a key. It goes away by itself. */
function showCopied(text: string) {
  const lines = text.split("\n");
  const first = lines[0].length > 48 ? lines[0].slice(0, 47) + "…" : lines[0];
  const what = lines.length > 1 ? `${lines.length} lines` : first;
  document.querySelector(".copy-hint")?.remove();
  const el = h("div", { class: "copy-hint", role: "status" }, h("span", { class: "copy-hint-check" }, "✓"), " Copied ", h("span", { class: "copy-hint-text" }, what));
  const nearMouse = Date.now() - lastPress.time < 1500;
  if (nearMouse) Object.assign(el.style, { left: `${lastPress.x + 12}px`, top: `${lastPress.y + 14}px` });
  else el.classList.add("bottom");
  document.body.append(el);
  if (nearMouse) {
    // Keep the hint in the window.
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth - 8) el.style.left = `${Math.max(8, window.innerWidth - 8 - r.width)}px`;
    if (r.bottom > window.innerHeight - 8) el.style.top = `${lastPress.y - r.height - 10}px`;
  }
  setTimeout(() => el.classList.add("out"), 1100);
  setTimeout(() => el.remove(), 1400);
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showCopied(text);
    return;
  } catch {}
  // The text field takes the focus for the copy; the focus then goes back, so the keys of a list still work.
  const focused = document.activeElement as HTMLElement | null;
  const ta = h("textarea", { value: text, style: { position: "fixed", opacity: "0" } });
  document.body.append(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
  focused?.focus({ preventScroll: true });
  showCopied(text);
}

export function formatDate(seconds: number): string {
  if (!seconds) return "";
  const d = new Date(seconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A splitter between the top and the rest of a column: the top gets the height that the user drags,
 * and the setting `key` keeps it. */
export function rowSplitter(column: HTMLElement, top: HTMLElement, height: () => number, setHeight: (px: number) => void, done: () => void): HTMLElement {
  const grip = h("div", { class: "hgrip-row column-grip", title: "Drag to resize" });
  const apply = (px: number) => {
    top.style.flex = `0 0 ${px}px`;
    top.style.maxHeight = "none";
  };
  apply(height());
  let start = 0;
  dragResize(grip, "y", () => (start = top.getBoundingClientRect().height), (d) => {
    const px = Math.max(40, Math.min(column.clientHeight - 120, start + d));
    setHeight(px);
    apply(px);
  }, done);
  return grip;
}

/** Makes `handle` resize something by dragging; `onMove` gets the pointer delta from the drag start. */
export function dragResize(handle: HTMLElement, axis: "x" | "y", onStart: () => void, onMove: (delta: number) => void, onEnd: () => void) {
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const start = axis === "x" ? e.clientX : e.clientY;
    onStart();
    document.body.classList.add(axis === "x" ? "resizing-x" : "resizing-y");
    const move = (ev: MouseEvent) => onMove((axis === "x" ? ev.clientX : ev.clientY) - start);
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing-x", "resizing-y");
      onEnd();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
}
