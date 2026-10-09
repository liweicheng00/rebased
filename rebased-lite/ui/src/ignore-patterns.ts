// The lines of the global ignore file: common patterns, and patterns for files of the Changes tab.

/** Patterns that editors and systems make in each repository. The page adds them with one click. */
export const COMMON_IGNORES: [string, string][] = [
  [".idea/", "JetBrains IDEs"],
  [".vscode/", "Visual Studio Code"],
  [".DS_Store", "Finder on macOS"],
  ["Thumbs.db", "Windows Explorer"],
  ["*.swp", "Vim"],
  ["*~", "Backup files"],
  [".history/", "Local History of VS Code"],
];

/** The text with the pattern on its own line at the end. A pattern that is there stays once. */
export function addIgnoreLine(text: string, pattern: string): string {
  if (text.split(/\r?\n/).some((l) => l.trim() === pattern)) return text;
  const base = text === "" || text.endsWith("\n") ? text : text + "\n";
  return base + pattern + "\n";
}

/** Patterns for the global ignore file: the name of each file or folder, so they match in any folder. */
export function globalPatterns(paths: string[]): string[] {
  return [...new Set(paths.map((p) => (p.endsWith("/") ? p.replace(/\/+$/, "").split("/").pop() + "/" : p.split("/").pop()!)))];
}
