// The zoom of the window: Zoom In, Zoom Out and Actual Size, as in a browser. The level stays in the settings.

import { setZoom } from "./api";
import { save, settings } from "./settings";
import { statusActivity } from "./shell";

/** The zoom levels, as the steps of a browser. */
export const ZOOM_LEVELS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

/** Applies the zoom of the settings, for example at the start. */
export function applyZoom() {
  if (settings.zoom !== 1) void setZoom(settings.zoom);
}

function setLevel(level: number) {
  settings.zoom = level;
  save();
  void setZoom(level);
  statusActivity.textContent = `Zoom ${Math.round(level * 100)}%`;
}

/** The next level up (1) or down (-1) from the current one. */
export function zoomBy(step: 1 | -1) {
  const cur = settings.zoom;
  const next = step > 0 ? ZOOM_LEVELS.find((l) => l > cur + 0.001) : [...ZOOM_LEVELS].reverse().find((l) => l < cur - 0.001);
  if (next !== undefined) setLevel(next);
}

export function resetZoom() {
  setLevel(1);
}
