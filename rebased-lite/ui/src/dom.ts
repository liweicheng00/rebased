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

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {}
  const ta = h("textarea", { value: text, style: { position: "fixed", opacity: "0" } });
  document.body.append(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
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
