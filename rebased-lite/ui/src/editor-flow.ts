// Open in Editor: opens the file of a diff or a list in the editor of the settings, at the line of the cursor.

import { api } from "./api";
import type { DiffView } from "./diff-view";
import { sharedDiff } from "./history-view";
import { toast } from "./notify";
import { commitPanel, diff, statusActivity } from "./shell";

export async function openInEditor(path: string, line = 1, column = 1) {
  try {
    await api.openInEditor(path, line, column);
    statusActivity.textContent = `Opened ${path.split("/").pop()}:${line} in the editor`;
  } catch (e) {
    toast(String(e).replace(/^Error: /, ""), "error");
  }
}

for (const d of [diff, sharedDiff()]) d.onOpenInEditor = (path, line, column) => void openInEditor(path, line, column);

/** A file of a list: at the cursor when the diff shows that file, else at its first line. */
function fromList(path: string, view: DiffView) {
  const p = view.currentPath === path ? view.editorPosition() : { line: 1, column: 1 };
  void openInEditor(path, p.line, p.column);
}

/** The key of Open in Editor. A window over the main view has its own diff. In the Changes tab it is the
 * selected file. Else it is the file of the diff panel, which also shows the file of a commit list. */
export function openInEditorHere(target: HTMLElement) {
  const windows = document.querySelectorAll(".merge-overlay");
  if (windows.length) {
    // The merge tool has no DiffView. The key does nothing there.
    if (windows[windows.length - 1].contains(sharedDiff().el)) sharedDiff().openInEditor();
    return;
  }
  if (target.closest(".commit-tree")) {
    const f = commitPanel.selectedFiles()[0];
    if (f) return fromList(f.change.path, diff);
  }
  diff.openInEditor();
}
