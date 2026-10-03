// The icon of a file type, from Material Icon Theme (MIT): the file icons that VS Code users know.
// scripts/file-icons.mjs makes the map from names and extensions to icons. Vite copies only the file
// icons of the package, not its folder icons.

import { ICONS } from "./file-icons.gen";

const urls = import.meta.glob<string>(["/node_modules/material-icon-theme/icons/*.svg", "!/node_modules/material-icon-theme/icons/folder*.svg"], {
  query: "?url",
  import: "default",
  eager: true,
});

const url = (name: string) => urls[`/node_modules/material-icon-theme/icons/${name}.svg`];

/** The icon name of a file: by its name first, then by its longest extension, as VS Code does. */
export function iconName(path: string, light = false): string {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  for (const m of light ? [ICONS.light, ICONS.dark] : [ICONS.dark]) {
    const byName = (m.names as Record<string, string>)[name];
    if (byName) return byName;
  }
  // "app.module.ts" tries "module.ts", then "ts".
  const parts = name.split(".");
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join(".");
    for (const m of light ? [ICONS.light, ICONS.dark] : [ICONS.dark]) {
      const byExt = (m.exts as Record<string, string>)[ext];
      if (byExt) return byExt;
    }
  }
  return ICONS.file;
}

/** The icon of a file, 16×16 pixels. It follows the light or the dark theme of the page. */
export function fileIcon(path: string): HTMLImageElement {
  const light = document.documentElement.dataset.theme === "light";
  const name = iconName(path, light);
  const img = document.createElement("img");
  img.className = "file-icon";
  img.src = url(name) ?? url(ICONS.file) ?? "";
  img.width = 16;
  img.height = 16;
  img.alt = "";
  img.draggable = false;
  return img;
}
