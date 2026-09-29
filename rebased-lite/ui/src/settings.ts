// Per-user preferences, kept in localStorage. Every access is guarded: storage can be unavailable.

export type Theme = "system" | "light" | "dark";

export interface Settings {
  intelliSort: boolean;
  showLongEdges: boolean;
  collapseLinear: boolean;
  theme: Theme;
  showAuthor: boolean;
  showDate: boolean;
  showHash: boolean;
  showSidebar: boolean;
  leftTab: "branches" | "commit" | "stash";
  updateMode: "merge" | "rebase";
  autoRefresh: boolean;
  changesAsTree: boolean;
  sideBySide: boolean;
  ignoreWhitespace: boolean;
  collapseUnchanged: boolean;
  sidebarWidth: number;
  rightWidth: number;
  diffRatio: number;
  detailsRatio: number;
  authorWidth: number;
  dateWidth: number;
  recent: string[];
  /** The repositories open in tabs, and the active one. They open again at the next start. */
  tabs: string[];
  activeTab: string | null;
}

const DEFAULTS: Settings = {
  intelliSort: true,
  showLongEdges: false,
  collapseLinear: false,
  theme: "system",
  showAuthor: true,
  showDate: true,
  showHash: true,
  showSidebar: true,
  leftTab: "branches",
  updateMode: "merge",
  autoRefresh: true,
  changesAsTree: true,
  sideBySide: true,
  ignoreWhitespace: false,
  collapseUnchanged: false,
  sidebarWidth: 280,
  rightWidth: 360,
  diffRatio: 0.42,
  detailsRatio: 0.55,
  authorWidth: 150,
  dateWidth: 125,
  recent: [],
  tabs: [],
  activeTab: null,
};

const KEY = "rebased-lite.settings.v1";

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {}
  return { ...DEFAULTS };
}

export const settings: Settings = load();

export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {}
}

export function addRecent(path: string) {
  settings.recent = [path, ...settings.recent.filter((p) => p !== path)].slice(0, 12);
  save();
}

export function removeRecent(path: string) {
  settings.recent = settings.recent.filter((p) => p !== path);
  save();
}
