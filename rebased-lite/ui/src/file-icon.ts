// The icon of a file type: a small page in the color of the type, with a short label. It needs no icon
// font, so it works the same in the app and in a browser.

const SVG = "http://www.w3.org/2000/svg";

/** Label and color by extension. */
const TYPES: Record<string, [string, string]> = {
  swift: ["SW", "#f05138"],
  py: ["PY", "#3572a5"],
  js: ["JS", "#d4b11f"],
  mjs: ["JS", "#d4b11f"],
  cjs: ["JS", "#d4b11f"],
  jsx: ["JSX", "#d4b11f"],
  ts: ["TS", "#3178c6"],
  tsx: ["TSX", "#3178c6"],
  rs: ["RS", "#c9693b"],
  go: ["GO", "#00add8"],
  java: ["JV", "#b07219"],
  kt: ["KT", "#a97bff"],
  kts: ["KT", "#a97bff"],
  c: ["C", "#6e7681"],
  h: ["H", "#6e7681"],
  cpp: ["C++", "#f34b7d"],
  hpp: ["H++", "#f34b7d"],
  m: ["M", "#438eff"],
  cs: ["C#", "#178600"],
  rb: ["RB", "#cc342d"],
  php: ["PHP", "#4f5d95"],
  html: ["<>", "#e34c26"],
  htm: ["<>", "#e34c26"],
  vue: ["VUE", "#41b883"],
  css: ["CSS", "#563d7c"],
  scss: ["CSS", "#c6538c"],
  json: ["{}", "#b29a18"],
  yaml: ["YML", "#cb171e"],
  yml: ["YML", "#cb171e"],
  toml: ["TML", "#9c4221"],
  xml: ["XML", "#0060ac"],
  plist: ["XML", "#0060ac"],
  pbxproj: ["XC", "#1575f9"],
  xcscheme: ["XC", "#1575f9"],
  storyboard: ["XC", "#1575f9"],
  md: ["MD", "#519aba"],
  txt: ["TXT", "#6e7681"],
  sh: ["SH", "#4d9a2a"],
  zsh: ["SH", "#4d9a2a"],
  sql: ["SQL", "#e38c00"],
  png: ["IMG", "#a074c4"],
  jpg: ["IMG", "#a074c4"],
  jpeg: ["IMG", "#a074c4"],
  gif: ["IMG", "#a074c4"],
  svg: ["SVG", "#a074c4"],
  pdf: ["PDF", "#d9363e"],
  lock: ["LCK", "#6e7681"],
};

/** Names without a useful extension. */
const NAMES: Record<string, [string, string]> = {
  dockerfile: ["DK", "#2496ed"],
  makefile: ["MK", "#6d8086"],
  "package.json": ["NPM", "#cb3837"],
  "cargo.toml": ["RS", "#c9693b"],
  ".gitignore": ["GIT", "#f05033"],
  ".gitmodules": ["GIT", "#f05033"],
  ".gitattributes": ["GIT", "#f05033"],
};

export function fileType(path: string): [string, string] {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (NAMES[name]) return NAMES[name];
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : "";
  return TYPES[ext] ?? [ext.slice(0, 3).toUpperCase(), "#8b949e"];
}

/** The icon of a file, 14×16 pixels. */
export function fileIcon(path: string): SVGSVGElement {
  const [label, color] = fileType(path);
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "file-icon");
  svg.setAttribute("viewBox", "0 0 14 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  const page = document.createElementNS(SVG, "path");
  page.setAttribute("d", "M1.5 0.5h7.5l4.5 4.5v9.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z");
  page.setAttribute("fill", color);
  const fold = document.createElementNS(SVG, "path");
  fold.setAttribute("d", "M9 0.5v3.5a1 1 0 0 0 1 1h3.5");
  fold.setAttribute("fill", "rgba(255,255,255,0.35)");
  svg.append(page, fold);
  if (label) {
    const text = document.createElementNS(SVG, "text");
    text.setAttribute("x", "7");
    text.setAttribute("y", "13");
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("font-size", label.length > 2 ? "4.6" : "5.6");
    text.setAttribute("font-weight", "700");
    text.setAttribute("font-family", "system-ui, sans-serif");
    text.setAttribute("fill", "#fff");
    text.textContent = label;
    svg.append(text);
  }
  return svg;
}
