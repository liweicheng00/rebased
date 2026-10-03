// A tree of folders for a file list. A chain of folders with one child each shows as one row, as in
// IntelliJ: "Views/Common/OrderView".

export interface TreeDir {
  dirs: Map<string, TreeDir>;
  /** The indexes of the files in this folder, in the order of the list. */
  files: number[];
}

export function buildTree(items: { path: string; index: number }[]): TreeDir {
  const root: TreeDir = { dirs: new Map(), files: [] };
  for (const it of items) {
    let d = root;
    for (const p of it.path.split("/").slice(0, -1)) {
      if (!d.dirs.has(p)) d.dirs.set(p, { dirs: new Map(), files: [] });
      d = d.dirs.get(p)!;
    }
    d.files.push(it.index);
  }
  return root;
}

/** The order of the tree: in each folder, the folders first, then the files, each by name. */
export function treeOrder(a: string, b: string): number {
  const pa = a.split("/");
  const pb = b.split("/");
  for (let i = 0; ; i++) {
    const aFile = i === pa.length - 1;
    const bFile = i === pb.length - 1;
    if (aFile !== bFile) return aFile ? 1 : -1;
    const c = pa[i].localeCompare(pb[i]);
    if (c !== 0 || aFile) return c;
  }
}

function allFiles(d: TreeDir): number[] {
  return [...d.files, ...[...d.dirs.values()].flatMap(allFiles)];
}

export interface TreeVisitor {
  dir: (label: string, full: string, depth: number, open: boolean, count: number, viewed: number) => void;
  file: (index: number, depth: number) => void;
  /** True when the file counts as viewed, for the count of a folder. */
  viewed?: (index: number) => boolean;
}

/** Visits the rows of the tree in order. The files of a closed folder are not visited. */
export function walkTree(d: TreeDir, collapsed: Set<string>, v: TreeVisitor, path = "", depth = 0) {
  for (const [name, sub] of [...d.dirs].sort(([a], [b]) => a.localeCompare(b))) {
    let label = name;
    let node = sub;
    while (node.files.length === 0 && node.dirs.size === 1) {
      const [n, s] = [...node.dirs][0];
      label += "/" + n;
      node = s;
    }
    const full = path + label + "/";
    const open = !collapsed.has(full);
    const files = allFiles(node);
    v.dir(label, full, depth, open, files.length, v.viewed ? files.filter(v.viewed).length : 0);
    if (open) walkTree(node, collapsed, v, full, depth + 1);
  }
  for (const i of [...d.files]) v.file(i, depth);
}
