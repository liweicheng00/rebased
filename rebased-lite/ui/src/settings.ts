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
  leftTab: "branches" | "commit" | "stash" | "reviews";
  updateMode: "merge" | "rebase";
  autoRefresh: boolean;
  changesAsTree: boolean;
  /** The file list of a review is a tree of folders. */
  reviewAsTree: boolean;
  sideBySide: boolean;
  ignoreWhitespace: boolean;
  collapseUnchanged: boolean;
  sidebarWidth: number;
  rightWidth: number;
  diffRatio: number;
  /** The diff panel below the log is shown. Its size (diffRatio) stays while it is hidden. */
  showDiff: boolean;
  /** The height of the commit lists of the Compare and Review windows, in pixels. */
  compareCommitsHeight: number;
  reviewCommitsHeight: number;
  detailsRatio: number;
  /** The largest width of the graph column, in pixels. The subject covers the rest of the graph. 0 shows all of the graph. */
  graphWidth: number;
  authorWidth: number;
  dateWidth: number;
  recent: string[];
  /** The git program; empty means git from PATH. */
  gitPath: string;
  /** Fetch all remotes of the active repository every this many minutes; 0 turns it off. */
  autoFetchMinutes: number;
  diffFontSize: number;
  /** Empty means the default monospace font. */
  diffFontFamily: string;
  /** Local History keeps versions this many days, and at most this many MB. */
  historyDays: number;
  historyMaxMb: number;
  /** Favorite branches and tags by repository root, as full ref names. A repository without an entry has
   * main and master as favorites. */
  favorites: Record<string, string[]>;
  /** The last commit messages, newest first. */
  messageHistory: string[];
  /** Add "Signed-off-by" to commits. */
  signOff: boolean;
  /** Commit message checks: the longest subject and body line; 0 turns a check off. */
  subjectLimit: number;
  bodyLimit: number;
  /** Check for a blank line between the subject and the body. */
  blankAfterSubject: boolean;
  /** The keys of the actions that the user changed, by action id. */
  keymap: Record<string, string[]>;
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
  reviewAsTree: true,
  sideBySide: true,
  ignoreWhitespace: false,
  collapseUnchanged: false,
  sidebarWidth: 280,
  rightWidth: 360,
  diffRatio: 0.42,
  showDiff: true,
  compareCommitsHeight: 300,
  reviewCommitsHeight: 180,
  detailsRatio: 0.55,
  graphWidth: 0,
  authorWidth: 150,
  dateWidth: 125,
  recent: [],
  tabs: [],
  activeTab: null,
  gitPath: "",
  autoFetchMinutes: 0,
  diffFontSize: 12,
  diffFontFamily: "",
  historyDays: 5,
  historyMaxMb: 200,
  keymap: {},
  favorites: {},
  messageHistory: [],
  signOff: false,
  subjectLimit: 72,
  bodyLimit: 72,
  blankAfterSubject: true,
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
