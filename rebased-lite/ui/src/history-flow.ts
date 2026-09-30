// File history, Local History and blame.

import { api } from "./api";
import { confirmDialog } from "./dialogs";
import { openHistory } from "./history-view";
import { openLocalHistory } from "./local-history-view";
import { runOp } from "./operations";
import { jumpToOid, loadLocalChanges } from "./repo";
import { diff, localHistoryBtn } from "./shell";

export function showHistory(path: string) {
  void openHistory(path, {
    load: api.fileHistory,
    pair: api.filePair,
    blame: api.blame,
    showInLog: (oid) => void jumpToOid(oid, true),
  });
}

export function showLocalHistory(path: string) {
  void openLocalHistory(path, {
    load: api.localHistory,
    content: api.localHistoryContent,
    current: async (p) => (await api.filePair("worktree", "worktree", p, null)).right,
    revert: async (r) => {
      const what = r.blob ? `Write the version of ${formatLocalTime(r.time)} back to ${r.path}?` : `Delete ${r.path}? It did not exist at ${formatLocalTime(r.time)}.`;
      if (!(await confirmDialog("Revert to a Local History version", `${what} Local History keeps the current content first.`, "Revert"))) return false;
      const out = await runOp({ op: "revertLocalHistory", path: r.path, blob: r.blob }, `Reverting ${r.path}`);
      if (out?.result.ok) void loadLocalChanges();
      return !!out?.result.ok;
    },
  });
}
const formatLocalTime = (ms: number) => new Date(ms).toLocaleString();
localHistoryBtn.addEventListener("click", () => showLocalHistory(""));

diff.onBlame = api.blame;
diff.onBlameClick = (oid) => void jumpToOid(oid, true);
diff.onHistory = showHistory;
