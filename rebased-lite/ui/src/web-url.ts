// The web page of a remote: the URL of a git remote turned into the URL of its page on GitHub, GitLab,
// Bitbucket, Azure DevOps, Gitea and similar hosts.

/** The web URL of a repository, from its remote URL. Null for a local path or an unknown form. */
export function webUrl(remote: string): string | null {
  let u = remote.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  let scheme = "https";
  let host = "";
  let path = "";
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(u);
  const full = /^([a-z+]+):\/\/(?:[^@/]+@)?([^/:]+)(?::(\d+))?\/(.+)$/i.exec(u);
  if (full) {
    const proto = full[1].toLowerCase();
    if (proto === "file") return null;
    host = full[2];
    path = full[4];
    // An http(s) remote keeps its scheme and port; an ssh port is not the port of the web page.
    if (proto === "http" || proto === "https") {
      scheme = proto;
      if (full[3]) host += `:${full[3]}`;
    }
  } else if (scp && !/^[a-z]:[\\/]/i.test(u)) {
    host = scp[1];
    path = scp[2].replace(/^\/+/, "");
  } else {
    return null;
  }
  // Azure DevOps: ssh.dev.azure.com:v3/org/project/repo and https://dev.azure.com/org/project/_git/repo.
  if (host === "ssh.dev.azure.com" && path.startsWith("v3/")) {
    const [org, project, repo] = path.slice(3).split("/");
    return `https://dev.azure.com/${org}/${project}/_git/${repo}`;
  }
  u = `${scheme}://${host}/${path}`;
  return u;
}

type Host = "github" | "gitlab" | "bitbucket" | "azure";

function hostKind(web: string): Host {
  const host = new URL(web).hostname;
  if (host.includes("gitlab")) return "gitlab";
  if (host.includes("bitbucket")) return "bitbucket";
  if (host.endsWith("dev.azure.com") || host.endsWith("visualstudio.com")) return "azure";
  // GitHub, Gitea, Forgejo, Gogs and most others use the GitHub paths.
  return "github";
}

const encodeRef = (ref: string) => ref.split("/").map(encodeURIComponent).join("/");

/** The page of a branch of the repository at `web`. */
export function branchUrl(web: string, branch: string): string {
  switch (hostKind(web)) {
    case "gitlab":
      return `${web}/-/tree/${encodeRef(branch)}`;
    case "bitbucket":
      return `${web}/src/${encodeRef(branch)}`;
    case "azure":
      return `${web}?version=GB${encodeURIComponent(branch)}`;
    default:
      return `${web}/tree/${encodeRef(branch)}`;
  }
}

/** The page of a commit of the repository at `web`. */
export function commitUrl(web: string, oid: string): string {
  switch (hostKind(web)) {
    case "gitlab":
      return `${web}/-/commit/${oid}`;
    case "bitbucket":
      return `${web}/commits/${oid}`;
    default:
      return `${web}/commit/${oid}`;
  }
}
