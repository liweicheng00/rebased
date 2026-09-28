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
