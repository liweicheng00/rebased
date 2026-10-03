// The order of tags: tags with the same prefix stay together, and in a group the highest version comes
// first. "v1.10.0" comes before "v1.9.0", and "v1.0.0" before "v1.0.0-rc.2".

interface Parsed {
  prefix: string;
  numbers: number[];
  /** The part after the numbers, for example "-rc.2". Empty for a release. */
  pre: string;
}

function parse(name: string): Parsed | null {
  const m = /^(.*?)(\d+(?:\.\d+)*)(.*)$/.exec(name);
  if (!m) return null;
  return { prefix: m[1].replace(/v$/i, ""), numbers: m[2].split(".").map(Number), pre: m[3] };
}

/** Sorts tag names: by prefix, then the newest version first. Names without a number go last. */
export function compareTags(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return pa ? -1 : pb ? 1 : a.localeCompare(b);
  if (pa.prefix !== pb.prefix) return pa.prefix.localeCompare(pb.prefix);
  for (let i = 0; i < Math.max(pa.numbers.length, pb.numbers.length); i++) {
    const d = (pb.numbers[i] ?? 0) - (pa.numbers[i] ?? 0);
    if (d !== 0) return d;
  }
  // A release comes before its pre-releases.
  if (!pa.pre !== !pb.pre) return pa.pre ? 1 : -1;
  return pb.pre.localeCompare(pa.pre, undefined, { numeric: true });
}
