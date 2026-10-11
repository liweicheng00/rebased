// Protected branches, as in IntelliJ: no force push to them, and no rewrite of commits that are on them.
// The setting holds glob patterns of branch names, for example "main release/*".

import { api } from "./api";
import { toast } from "./notify";
import { settings } from "./settings";

/** The patterns of the setting as regular expressions. `*` matches any characters. */
function patterns(): RegExp[] {
  return settings.protectedBranches
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`));
}

/** True when a branch name without its remote ("main", "release/1.0") is protected. */
export function isProtected(branch: string): boolean {
  return patterns().some((r) => r.test(branch));
}

/** The protected remote branches ("origin/main") that contain a commit. */
export async function protectedContaining(oid: string): Promise<string[]> {
  if (!patterns().length) return [];
  const remotes = await api.remoteContaining(oid).catch(() => [] as string[]);
  return remotes.filter((r) => isProtected(r.slice(r.indexOf("/") + 1)));
}

/** False, with a notice, when a rewrite would change a commit of a protected branch. The oldest commit of
 * the rewrite is enough: a protected branch that has a newer commit has its parents too. */
export async function allowRewrite(oldest: string): Promise<boolean> {
  const hit = await protectedContaining(oldest);
  if (!hit.length) return true;
  toast(`The commits are on the protected branch ${hit[0]}. Rebased Lite does not rewrite them. Settings › Git › Protected branches.`, "error");
  return false;
}
