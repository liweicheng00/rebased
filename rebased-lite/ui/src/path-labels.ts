// Short names for a set of folders, as the tabs and the worktree list show them. A folder name that
// is unique stays alone. Folders with the same name get the folders above them, one at a time, until
// the names differ: "work/app" and "old/app".

/** The parts of a path, without empty parts. */
function parts(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean);
}

/** A short, unique label for each path, in the order of `paths`. */
export function pathLabels(paths: string[]): string[] {
  const split = paths.map(parts);
  const depth = paths.map(() => 1);
  const label = (i: number) => split[i].slice(-depth[i]).join("/") || paths[i];
  // Each round, the labels that two or more paths share take one more folder.
  for (let round = 0; round < 64; round++) {
    const groups = new Map<string, number[]>();
    paths.forEach((_, i) => {
      const l = label(i);
      groups.set(l, [...(groups.get(l) ?? []), i]);
    });
    let changed = false;
    for (const same of groups.values()) {
      if (same.length < 2) continue;
      for (const i of same) {
        if (depth[i] < split[i].length) {
          depth[i]++;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return paths.map((_, i) => label(i));
}
