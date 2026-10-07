// The icons of the app, from Lucide (ISC license): the line icons of the npm package lucide-static. Each
// icon is a mask, so it takes the color of the text in both themes. Vite copies only the files below.

const files = import.meta.glob<string>(
  "/node_modules/lucide-static/icons/{folder-open,cloud-download,arrow-down-to-line,arrow-up-from-line,globe,history,sun-moon,settings,git-branch,arrow-up,arrow-down,arrow-left-to-line,arrow-right-to-line,copy,square-pen,x,chevrons-up-down,chevrons-down-up,plus,list,folder-tree,arrow-left-right,star,tag,circle-dot,rotate-ccw,message-square,triangle-alert,chevron-right,chevron-down,undo-2,rotate-cw,chevrons-right,lock,funnel,folder-git-2,package}.svg",
  { query: "?raw", import: "default", eager: true },
);

/** The icon names of the app, and their Lucide files. */
const NAMES = {
  open: "folder-open",
  fetch: "cloud-download",
  update: "arrow-down-to-line",
  push: "arrow-up-from-line",
  remote: "globe",
  history: "history",
  theme: "sun-moon",
  settings: "settings",
  branch: "git-branch",
  up: "arrow-up",
  down: "arrow-down",
  "prev-file": "arrow-left-to-line",
  "next-file": "arrow-right-to-line",
  copy: "copy",
  edit: "square-pen",
  close: "x",
  expand: "chevrons-up-down",
  collapse: "chevrons-down-up",
  add: "plus",
  list: "list",
  tree: "folder-tree",
  swap: "arrow-left-right",
  star: "star",
  tag: "tag",
  current: "circle-dot",
  reset: "rotate-ccw",
  note: "message-square",
  warning: "triangle-alert",
  "chevron-right": "chevron-right",
  "chevron-down": "chevron-down",
  revert: "undo-2",
  refresh: "rotate-cw",
  apply: "chevrons-right",
  lock: "lock",
  filter: "funnel",
  worktree: "folder-git-2",
  submodule: "package",
} as const;

export type IconName = keyof typeof NAMES | "star-filled";

/** The mask of an SVG: the color is black, and only its shape counts. */
function mask(svg: string, filled = false): string {
  let s = svg.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ").replace(/currentColor/g, "black").trim();
  if (filled) s = s.replace('fill="none"', 'fill="black"');
  return `url("data:image/svg+xml,${encodeURIComponent(s)}")`;
}

/** The style rules: a custom property for each icon, and a class that uses it. */
function styleSheet(): string {
  const rules: string[] = [];
  const vars: string[] = [];
  const add = (name: string, url: string) => {
    vars.push(`--icon-${name}: ${url};`);
    rules.push(`.icon-${name} { --icon: var(--icon-${name}); }`);
  };
  for (const [name, file] of Object.entries(NAMES)) {
    const svg = files[`/node_modules/lucide-static/icons/${file}.svg`];
    if (svg) add(name, mask(svg));
    if (svg && name === "star") add("star-filled", mask(svg, true));
  }
  return `:root { ${vars.join(" ")} }\n${rules.join("\n")}`;
}

if (typeof document !== "undefined") {
  const style = document.createElement("style");
  style.id = "icons";
  style.textContent = styleSheet();
  document.head.append(style);
}

/** An icon, for example icon("refresh"). It takes the color of the text. */
export function icon(name: IconName, extra = ""): HTMLElement {
  const el = document.createElement("span");
  el.className = `icon icon-${name}${extra ? " " + extra : ""}`;
  el.setAttribute("aria-hidden", "true");
  return el;
}

/** The twisty of a tree row or a group: a chevron that points down when the row is open. */
export function twisty(open: boolean): HTMLElement {
  const el = document.createElement("span");
  el.className = "twisty" + (open ? " open" : "");
  el.append(icon("chevron-right"));
  return el;
}
