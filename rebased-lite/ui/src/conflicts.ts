// Merge conflicts and the merge window.

import { api, type Op } from "./api";
import { conflictsDialog } from "./dialogs";
import { openMergeTool } from "./merge-view";
import { toast } from "./notify";
import { runOp } from "./operations";
import { banner } from "./shell";

/** Opens the merge window for one file. Returns true when the file was resolved. */
export async function mergeFile(path: string): Promise<boolean> {
  let sides;
  try {
    sides = await api.mergeSides(path);
  } catch (e) {
    toast(String(e).replace(/^Error: /, ""), "error");
    return false;
  }
  if (sides.binary || sides.ours.text === null || sides.theirs.text === null) {
    const why = sides.binary ? "is binary" : sides.ours.text === null ? "was deleted in yours" : "was deleted in theirs";
    const r = await conflictsDialog([path], sides.ours.label, sides.theirs.label);
    if (!r || r.action === "merge") {
      if (r) toast(`${path} ${why}. Take one whole side.`, "info");
      return false;
    }
    return !!(await runOp({ op: "resolveSide", paths: [path], side: r.action }, "Resolving"))?.result.ok;
  }
  const outcome = await openMergeTool({
    path,
    base: sides.base.text,
    ours: sides.ours.text,
    theirs: sides.theirs.text,
    oursLabel: sides.ours.label,
    theirsLabel: sides.theirs.label,
  });
  if (outcome.kind === "cancel") return false;
  const op: Op = outcome.kind === "save" ? { op: "resolveText", path, text: outcome.text } : { op: "resolveSide", paths: [path], side: outcome.side };
  return !!(await runOp(op, "Resolving"))?.result.ok;
}

/** The Conflicts dialog: repeats until no conflict is left or the user closes it. */
async function resolveConflicts() {
  for (;;) {
    const st = await api.repoState().catch(() => null);
    if (!st?.conflicts.length) return;
    const labels = await api.mergeSides(st.conflicts[0]).then((s) => [s.ours.label, s.theirs.label]).catch(() => ["yours", "theirs"]);
    const r = await conflictsDialog(st.conflicts, labels[0], labels[1]);
    if (!r) return;
    if (r.action === "merge") {
      await mergeFile(r.paths[0]);
    } else {
      await runOp({ op: "resolveSide", paths: r.paths, side: r.action }, "Resolving");
    }
  }
}

banner.onResolve = () => void resolveConflicts();
