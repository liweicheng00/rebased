//! Delete Merged Branches: deletes the local branches whose work is already on the branch that they
//! track. Git 2.56 has `git branch --delete-merged`. With an older git, this module applies the same
//! rules itself, so the result is the same.
//!
//! A branch stays when:
//! - its tracked branch does not exist,
//! - a worktree has it checked out,
//! - a push of the branch updates its tracked branch (the usual `main` that tracks `origin/main`),
//! - it is the tracked branch of a local branch that does not match the rules, or
//! - `branch.<name>.deleteMerged` is false.
//!
//! These rules are the rules of git 2.56. Two of them can surprise:
//! - The check of the tracked branch goes one level only. Git keeps B when A has its own work and
//!   tracks B, but it can delete C when B tracks C. Git then clears the tracked branch of B.
//! - The push check reads `remote.<name>.push` and the fetch refspecs only. With a push refspec such
//!   as `:` or `HEAD`, `main` that tracks `origin/main` can be deleted when it has no own commits.

use crate::undo::UndoAction;
use crate::ops::{safe, OpResult};
use crate::{GitError, Repo, Result};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[derive(ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct MergedBranch {
    pub name: String,
    pub oid: String,
    /// The tracked branch, for example `origin/main`.
    pub upstream: String,
    pub subject: String,
}

#[derive(Clone, Debug, Serialize)]
#[derive(ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct MergedBranches {
    pub branches: Vec<MergedBranch>,
    /// True when git finds the branches itself (`git branch --delete-merged`, Git 2.56 or later).
    pub native: bool,
}

/// The first git version with `git branch --delete-merged`.
pub const NATIVE_VERSION: (u32, u32) = (2, 56);

struct Local {
    name: String,
    oid: String,
    /// The full name of the tracked branch, or empty.
    upstream: String,
    checked_out: bool,
    subject: String,
}

/// The config of the repository: lowercase section and key, the subsection as written.
pub(crate) type Config = BTreeMap<String, Vec<String>>;

fn text(b: Vec<u8>) -> String {
    String::from_utf8_lossy(&b).trim().to_string()
}

fn short_ref(full: &str) -> &str {
    full.strip_prefix("refs/heads/").or_else(|| full.strip_prefix("refs/remotes/")).unwrap_or(full)
}

fn has_glob(p: &str) -> bool {
    p.contains(['*', '?', '[', '\\'])
}

/// A glob as git's `wildmatch` with `WM_PATHNAME`: `*` and `?` do not match `/`, and `**` matches
/// across directories.
pub(crate) fn glob_match(pattern: &str, text: &str) -> bool {
    fn go(p: &[char], t: &[char]) -> bool {
        match p.first() {
            None => t.is_empty(),
            Some('*') if p.get(1) == Some(&'*') => {
                let rest = &p[2..];
                (rest.first() == Some(&'/') && go(&rest[1..], t)) || (0..=t.len()).any(|i| go(rest, &t[i..]))
            }
            Some('*') => (0..=t.len()).take_while(|&i| i == 0 || t[i - 1] != '/').any(|i| go(&p[1..], &t[i..])),
            Some('?') => t.first().is_some_and(|c| *c != '/') && go(&p[1..], &t[1..]),
            Some('[') => {
                let Some(close) = p.iter().skip(2).position(|c| *c == ']').map(|i| i + 2) else {
                    return t.first() == Some(&'[') && go(&p[1..], &t[1..]);
                };
                let Some(&c) = t.first() else { return false };
                let set = &p[1..close];
                let (negate, set) = match set.first() {
                    Some('!') | Some('^') => (true, &set[1..]),
                    _ => (false, set),
                };
                let mut hit = false;
                let mut i = 0;
                while i < set.len() {
                    if i + 2 < set.len() && set[i + 1] == '-' {
                        hit |= set[i] <= c && c <= set[i + 2];
                        i += 3;
                    } else {
                        hit |= set[i] == c;
                        i += 1;
                    }
                }
                c != '/' && hit != negate && go(&p[close + 1..], &t[1..])
            }
            Some('\\') if p.len() > 1 => t.first() == Some(&p[1]) && go(&p[2..], &t[1..]),
            Some(c) => t.first() == Some(c) && go(&p[1..], &t[1..]),
        }
    }
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    go(&p, &t)
}

/// Maps a ref through refspecs, as git's `apply_refspecs`: the destination of the first match.
fn apply_refspecs(specs: &[String], name: &str) -> Option<String> {
    for spec in specs {
        let spec = spec.strip_prefix('+').unwrap_or(spec);
        if spec.starts_with('^') {
            continue;
        }
        let (src, dst) = spec.split_once(':').unwrap_or((spec, spec));
        match (src.split_once('*'), dst.split_once('*')) {
            (Some((sp, ss)), Some((dp, ds))) => {
                if let Some(mid) = name.strip_prefix(sp).and_then(|r| r.strip_suffix(ss)) {
                    return Some(format!("{dp}{mid}{ds}"));
                }
            }
            (None, _) if src == name && !dst.is_empty() => return Some(dst.to_string()),
            _ => {}
        }
    }
    None
}

impl Repo {
    /// The config of all scopes, for the rules.
    fn config_all(&self) -> Config {
        self.config_scope(&[])
    }

    /// The `branch.*` config of the repository only, for Undo: Undo writes to this file.
    pub(crate) fn config_local(&self) -> Config {
        self.config_scope(&["--local"]).into_iter().filter(|(k, _)| k.starts_with("branch.")).collect()
    }

    fn config_scope(&self, scope: &[&str]) -> Config {
        let mut map = Config::new();
        let mut args = vec!["config"];
        args.extend_from_slice(scope);
        args.extend(["-z", "--get-regexp", r"^(branch|remote)\."]);
        let out = self.git(&args).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
        for entry in out.split('\0').filter(|e| !e.is_empty()) {
            let (k, v) = entry.split_once('\n').unwrap_or((entry, ""));
            map.entry(k.to_string()).or_default().push(v.to_string());
        }
        map
    }

    fn cleanup_locals(&self) -> Result<Vec<Local>> {
        let out = self.git(&["for-each-ref", "--format=%(refname:lstrip=2)%00%(objectname)%00%(upstream)%00%(worktreepath)%00%(contents:subject)", "refs/heads"])?;
        Ok(String::from_utf8_lossy(&out)
            .lines()
            .filter_map(|l| {
                let mut p = l.split('\0');
                Some(Local {
                    name: p.next()?.to_string(),
                    oid: p.next()?.to_string(),
                    upstream: p.next()?.to_string(),
                    checked_out: !p.next()?.is_empty(),
                    subject: p.next().unwrap_or("").to_string(),
                })
            })
            .collect())
    }

    /// The full name of a branch, a remote branch, or the branch that the `HEAD` of a remote points to.
    fn dwim_branch(&self, arg: &str) -> Result<String> {
        let invalid = || GitError(format!("'{arg}' is not a valid branch or pattern"));
        let mut full = self.git(&["rev-parse", "--symbolic-full-name", safe(arg).map_err(|_| invalid())?]).map(text).map_err(|_| invalid())?;
        for _ in 0..5 {
            match self.git(&["symbolic-ref", "-q", &full]).map(text) {
                Ok(t) if !t.is_empty() => full = t,
                _ => break,
            }
        }
        if full.starts_with("refs/heads/") || full.starts_with("refs/remotes/") {
            Ok(full)
        } else {
            Err(invalid())
        }
    }

    /// True when a push of the branch updates its tracked branch, as git's `branch_pushes_to_upstream`.
    fn pushes_to_upstream(config: &Config, branch: &str, upstream: &str) -> bool {
        let get = |k: String| config.get(&k).cloned().unwrap_or_default();
        let remote = get(format!("branch.{branch}.remote")).pop().unwrap_or_else(|| "origin".into());
        let push = get(format!("remote.{remote}.push"));
        let refname = format!("refs/heads/{branch}");
        let pushed = if push.is_empty() { Some(refname) } else { apply_refspecs(&push, &refname) };
        pushed.and_then(|p| apply_refspecs(&get(format!("remote.{remote}.fetch")), &p)).as_deref() == Some(upstream)
    }

    /// The branches to delete, by the rules of `git branch --delete-merged`, for git before 2.56.
    /// `only` limits the branches that the rules look at.
    fn find_merged(&self, upstreams: &[String], only: Option<&[String]>) -> Result<Vec<String>> {
        enum Pattern {
            Glob(String),
            Exact(String),
        }
        let patterns = upstreams
            .iter()
            .map(|p| if has_glob(p) { Ok(Pattern::Glob(p.clone())) } else { self.dwim_branch(p).map(Pattern::Exact) })
            .collect::<Result<Vec<_>>>()?;
        let config = self.config_all();
        let locals = self.cleanup_locals()?;
        let mut deletable: HashSet<String> = HashSet::new();
        for l in &locals {
            if l.checked_out || l.upstream.is_empty() || only.is_some_and(|o| !o.contains(&l.name)) {
                continue;
            }
            let matches = patterns.iter().any(|p| match p {
                Pattern::Glob(g) => glob_match(g, short_ref(&l.upstream)),
                Pattern::Exact(e) => *e == l.upstream,
            });
            if !matches || self.git(&["rev-parse", "-q", "--verify", &l.upstream]).is_err() {
                continue;
            }
            if Self::pushes_to_upstream(&config, &l.name, &l.upstream) {
                continue;
            }
            if self.git(&["merge-base", "--is-ancestor", &l.oid, &l.upstream]).is_err() {
                continue;
            }
            let opt_out = config.get(&format!("branch.{}.deletemerged", l.name)).and_then(|v| v.last()).map(|v| v.to_ascii_lowercase());
            if matches!(opt_out.as_deref(), Some("false" | "no" | "off" | "0")) {
                continue;
            }
            deletable.insert(l.name.clone());
        }
        // A deletable branch that a staying branch tracks stays too.
        let protected: HashSet<String> = locals
            .iter()
            .filter(|l| !deletable.contains(&l.name))
            .filter_map(|l| l.upstream.strip_prefix("refs/heads/"))
            .filter(|b| deletable.contains(*b))
            .map(String::from)
            .collect();
        let mut out: Vec<String> = deletable.difference(&protected).cloned().collect();
        out.sort();
        Ok(out)
    }

    fn delete_merged_args<'a>(upstreams: &'a [String], branches: &'a [String], dry_run: bool) -> Result<Vec<&'a str>> {
        let mut args = vec!["branch"];
        if dry_run {
            args.push("--dry-run");
        }
        for u in upstreams {
            args.extend(["--delete-merged", safe(u)?]);
        }
        if !branches.is_empty() {
            args.push("--");
            for b in branches {
                args.push(safe(b)?);
            }
        }
        Ok(args)
    }

    /// The branches that a delete removes now. `only` limits the branches that the rules look at.
    fn plan(&self, upstreams: &[String], only: Option<&[String]>, native: bool) -> Result<Vec<String>> {
        match only {
            // Without names, git looks at all branches.
            Some([]) => Ok(Vec::new()),
            _ if native => self.native_dry_run(upstreams, only.unwrap_or(&[])),
            _ => self.find_merged(upstreams, only),
        }
    }

    fn native_dry_run(&self, upstreams: &[String], branches: &[String]) -> Result<Vec<String>> {
        let args = Self::delete_merged_args(upstreams, branches, true)?;
        let out = self.git_write(&args, &[]).map_err(|(_, e)| GitError(e))?;
        let mut names: Vec<String> = out
            .lines()
            .filter_map(|l| l.strip_prefix("Would delete branch ")?.rsplit_once(" (was ").map(|(n, _)| n.to_string()))
            .collect();
        names.sort();
        Ok(names)
    }

    /// The local branches that Delete Merged Branches deletes for these tracked-branch patterns. A pattern
    /// names a branch (`origin/main`), a remote (`origin`, the branch that its `HEAD` points to), or a glob
    /// (`origin/*`).
    pub fn merged_branches(&self, upstreams: &[String]) -> Result<MergedBranches> {
        self.merged_branches_with(upstreams, crate::git_at_least(NATIVE_VERSION))
    }

    pub fn merged_branches_with(&self, upstreams: &[String], native: bool) -> Result<MergedBranches> {
        if upstreams.is_empty() {
            return Ok(MergedBranches { branches: Vec::new(), native });
        }
        let names = self.plan(upstreams, None, native)?;
        let locals: HashMap<String, Local> = self.cleanup_locals()?.into_iter().map(|l| (l.name.clone(), l)).collect();
        let branches = names
            .into_iter()
            .filter_map(|n| {
                let l = locals.get(&n)?;
                Some(MergedBranch { name: n, oid: l.oid.clone(), upstream: short_ref(&l.upstream).to_string(), subject: l.subject.clone() })
            })
            .collect();
        Ok(MergedBranches { branches, native })
    }

    /// Deletes the merged branches, except the branches in `keep`. A kept branch can keep the branch
    /// that it tracks. `expected` is the list that the user saw. When the rules now give another list,
    /// for example after a fetch, nothing is deleted. Undo creates the deleted branches again and
    /// restores their config, also after a delete that failed part of the way.
    pub fn delete_merged(&self, upstreams: &[String], keep: &[String], expected: &[String]) -> Result<OpResult> {
        self.delete_merged_with(upstreams, keep, expected, crate::git_at_least(NATIVE_VERSION))
    }

    pub fn delete_merged_with(&self, upstreams: &[String], keep: &[String], expected: &[String], native: bool) -> Result<OpResult> {
        if upstreams.is_empty() {
            return Err(GitError("Give at least one tracked branch".into()));
        }
        let before_config = self.config_local();
        let before: HashMap<String, String> = self.cleanup_locals()?.into_iter().map(|l| (l.name, l.oid)).collect();
        // Only the names limit the branches, so all other branches go in when the user keeps some.
        let mut branches: Vec<String> = if keep.is_empty() { Vec::new() } else { before.keys().filter(|n| !keep.contains(n)).cloned().collect() };
        branches.sort();
        let only = (!keep.is_empty()).then_some(branches.as_slice());
        let mut names = self.plan(upstreams, only, native)?;
        names.sort();
        let mut want = expected.to_vec();
        want.sort();
        if names != want {
            return Err(GitError("The merged branches changed since the list was made. Look at the list again".into()));
        }
        if names.is_empty() {
            return Ok(OpResult::ok_msg("No merged branch to delete"));
        }
        let run = if native {
            let args = Self::delete_merged_args(upstreams, &branches, false)?;
            self.git_write(&args, &[]).map(|_| ())
        } else {
            let mut args = vec!["branch", "-D", "--"];
            args.extend(names.iter().map(String::as_str));
            let r = self.git_write(&args, &[]).map(|_| ());
            // A staying branch whose tracked branch is gone tracks nothing, as git does.
            let gone: HashSet<String> = names.iter().filter(|n| self.resolve(&format!("refs/heads/{n}")).is_none()).map(|n| format!("refs/heads/{n}")).collect();
            for l in self.cleanup_locals()? {
                if gone.contains(&l.upstream) {
                    let _ = self.git_write(&["config", "--unset", &format!("branch.{}.merge", l.name)], &[]);
                    let _ = self.git_write(&["config", "--unset", &format!("branch.{}.remote", l.name)], &[]);
                }
            }
            r
        };
        // Undo comes from the state before and after, so it also covers a delete that stopped halfway.
        let after: HashSet<String> = self.cleanup_locals()?.into_iter().map(|l| l.name).collect();
        let mut deleted: Vec<(&String, &String)> = before.iter().filter(|(n, _)| !after.contains(*n)).collect();
        deleted.sort();
        let mut undo: Vec<UndoAction> =
            deleted.iter().map(|(n, oid)| UndoAction::CreateRef { name: format!("refs/heads/{n}"), oid: (*oid).clone() }).collect();
        let after_config = self.config_local();
        for (k, v) in &before_config {
            if after_config.get(k) != Some(v) {
                undo.push(UndoAction::SetConfig { key: k.clone(), values: v.clone() });
            }
        }
        for k in after_config.keys().filter(|k| !before_config.contains_key(*k)) {
            undo.push(UndoAction::SetConfig { key: k.clone(), values: Vec::new() });
        }
        let n = deleted.len();
        if let Err((_, e)) = run {
            let message = if n == 0 { e } else { format!("{e}\n{n} of {} branches were deleted. Undo creates them again", names.len()) };
            return Ok(OpResult { ok: false, message, conflicts: Vec::new(), undo });
        }
        let message = if n == 1 { format!("Deleted merged branch {}", deleted[0].0) } else { format!("Deleted {n} merged branches") };
        Ok(OpResult { ok: true, message, conflicts: Vec::new(), undo })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn globs() {
        assert!(glob_match("origin/*", "origin/main"));
        assert!(!glob_match("origin/*", "origin/feature/x"));
        assert!(glob_match("origin/**", "origin/feature/x"));
        assert!(glob_match("*/main", "upstream/main"));
        assert!(glob_match("ma?n", "main"));
        assert!(glob_match("release-[0-9]", "release-3"));
        assert!(!glob_match("release-[!0-9]", "release-3"));
    }

    #[test]
    fn refspecs() {
        let fetch = vec!["+refs/heads/*:refs/remotes/origin/*".to_string()];
        assert_eq!(apply_refspecs(&fetch, "refs/heads/topic").as_deref(), Some("refs/remotes/origin/topic"));
        assert_eq!(apply_refspecs(&fetch, "refs/tags/v1"), None);
        let push = vec!["refs/heads/topic:refs/heads/main".to_string()];
        assert_eq!(apply_refspecs(&push, "refs/heads/topic").as_deref(), Some("refs/heads/main"));
    }
}
