// The order of git rebase --autosquash: a "fixup! X", "squash! X" or "amend! X" commit goes right after
// the commit X, with the fixup or squash action.

export interface SquashLine {
  oid: string;
  subject: string;
  action: string;
}

const PREFIX = /^(fixup|squash|amend)! (.*)$/;

/** Reorders the lines, oldest first, as git rebase --autosquash does. The lines change in place and come
 * back too. A line whose commit is not in the list stays where it is. */
export function autosquash<T extends SquashLine>(lines: T[]): T[] {
  const out: T[] = [];
  /** The fixup lines that moved after their commit already. */
  const moved = new Set<T>();
  for (const line of lines) {
    if (moved.has(line)) continue;
    out.push(line);
    for (const later of lines) {
      if (moved.has(later) || later === line) continue;
      const m = PREFIX.exec(later.subject);
      if (!m) continue;
      // A fixup of a fixup ("fixup! fixup! X") targets X too.
      let target = m[2];
      while (PREFIX.test(target)) target = PREFIX.exec(target)![2];
      const hits = target === line.subject || (target.length >= 4 && /^[0-9a-f]+$/.test(target) && line.oid.startsWith(target)) || line.subject.startsWith(target);
      if (!hits || lines.indexOf(later) < lines.indexOf(line)) continue;
      later.action = m[1] === "squash" ? "squash" : "fixup";
      moved.add(later);
      out.push(later);
    }
  }
  lines.splice(0, lines.length, ...out);
  return lines;
}
