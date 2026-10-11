//! Push and Update (pull), as in IntelliJ. Git never prompts: a remote that needs a password must have a
//! credential helper or an SSH agent.

use crate::ops::{safe, OpResult};
use crate::undo::UndoAction;
use crate::{GitError, Repo, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize)]
#[derive(ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingCommit {
    pub oid: String,
    pub subject: String,
    pub author: String,
    pub time: i64,
}

#[derive(Debug, Serialize)]
#[derive(ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PushInfo {
    pub branch: String,
    pub remotes: Vec<String>,
    /// The remote to push to. None when the repository has no remote.
    pub remote: Option<String>,
    pub remote_branch: String,
    /// The tracked branch, for example `origin/main`.
    pub upstream: Option<String>,
    /// The remote branch does not exist yet.
    pub new_branch: bool,
    pub outgoing: Vec<OutgoingCommit>,
    /// Commits on the remote branch that are not in the local branch. A push without force is rejected.
    pub behind: usize,
}

#[derive(Debug, Serialize)]
#[derive(ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub name: String,
    pub fetch_url: String,
    /// Set only when it differs from the fetch URL.
    pub push_url: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum UpdateMode {
    Merge,
    Rebase,
}

const MAX_OUTGOING: usize = 1000;

fn text(b: Vec<u8>) -> String {
    String::from_utf8_lossy(&b).trim().to_string()
}

impl Repo {
    pub fn remotes(&self) -> Result<Vec<String>> {
        Ok(text(self.git(&["remote"])?).lines().map(String::from).collect())
    }

    fn config(&self, key: &str) -> Option<String> {
        self.git(&["config", "--get", key]).ok().map(text).filter(|s| !s.is_empty())
    }

    fn current_branch(&self) -> Result<String> {
        self.git(&["symbolic-ref", "-q", "--short", "HEAD"]).map(text).map_err(|_| GitError("HEAD is detached. Checkout a branch first".into()))
    }

    /// The tracked branch as `remote/branch`, split into its parts.
    fn upstream_of(&self, branch: &str) -> Option<(String, String)> {
        let remote = self.config(&format!("branch.{branch}.remote"))?;
        let merge = self.config(&format!("branch.{branch}.merge"))?;
        let name = merge.strip_prefix("refs/heads/").unwrap_or(&merge).to_string();
        (remote != ".").then_some((remote, name))
    }

    /// What a push of `branch` sends. With no branch, it uses the current branch.
    pub fn push_info(&self, branch: Option<&str>) -> Result<PushInfo> {
        let branch = match branch {
            Some(b) => safe(b)?.to_string(),
            None => self.current_branch()?,
        };
        let remotes = self.remotes()?;
        let upstream = self.upstream_of(&branch);
        let remote = upstream
            .as_ref()
            .map(|u| u.0.clone())
            .or_else(|| self.config(&format!("branch.{branch}.pushRemote")))
            .or_else(|| self.config("remote.pushDefault"))
            .or_else(|| remotes.iter().find(|r| *r == "origin").cloned())
            .or_else(|| remotes.first().cloned());
        let remote_branch = upstream.as_ref().filter(|u| Some(&u.0) == remote.as_ref()).map_or(branch.clone(), |u| u.1.clone());
        let tracking = remote.as_ref().map(|r| format!("refs/remotes/{r}/{remote_branch}"));
        let exists = tracking.as_ref().is_some_and(|t| self.git(&["rev-parse", "-q", "--verify", t]).is_ok());
        let local = format!("refs/heads/{branch}");
        let range: Vec<String> = match (&tracking, exists) {
            (Some(t), true) => vec![format!("{t}..{local}")],
            (Some(_), false) => vec![local.clone(), "--not".into(), format!("--remotes={}", remote.as_deref().unwrap_or(""))],
            (None, _) => vec![local.clone()],
        };
        let mut args: Vec<String> = vec!["log".into(), format!("-n{MAX_OUTGOING}"), "--format=%H%x1f%s%x1f%an%x1f%ct".into()];
        args.extend(range);
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        let outgoing = text(self.git(&argv)?)
            .lines()
            .filter_map(|l| {
                let mut p = l.split('\x1f');
                Some(OutgoingCommit {
                    oid: p.next()?.to_string(),
                    subject: p.next()?.to_string(),
                    author: p.next()?.to_string(),
                    time: p.next()?.parse().ok()?,
                })
            })
            .collect();
        let behind = match (&tracking, exists) {
            (Some(t), true) => text(self.git(&["rev-list", "--count", &format!("{local}..{t}")])?).parse().unwrap_or(0),
            _ => 0,
        };
        Ok(PushInfo {
            branch,
            remotes,
            remote,
            remote_branch,
            upstream: upstream.map(|(r, b)| format!("{r}/{b}")),
            new_branch: !exists,
            outgoing,
            behind,
        })
    }

    /// Pushes a local branch. `force` uses `--force-with-lease`, so it never overwrites commits that
    /// were not fetched.
    pub fn push(&self, branch: &str, remote: &str, remote_branch: &str, force: bool, set_upstream: bool, tags: bool) -> Result<OpResult> {
        self.push_rev(branch, None, remote, remote_branch, force, set_upstream, tags)
    }

    /// Pushes a branch, or with `rev` only its commits up to that commit (Push All up to Here). The commit
    /// must be on the branch. A push up to a commit does not set the tracked branch.
    #[allow(clippy::too_many_arguments)]
    pub fn push_rev(&self, branch: &str, rev: Option<&str>, remote: &str, remote_branch: &str, force: bool, set_upstream: bool, tags: bool) -> Result<OpResult> {
        let (branch, remote, remote_branch) = (safe(branch)?, safe(remote)?, safe(remote_branch)?);
        let source = match rev {
            Some(r) => {
                let oid = self.resolve(safe(r)?).ok_or_else(|| GitError(format!("unknown commit {r}")))?;
                if self.git(&["merge-base", "--is-ancestor", &oid, &format!("refs/heads/{branch}")]).is_err() {
                    return Err(GitError(format!("{} is not on {branch}", &oid[..8])));
                }
                oid
            }
            None => format!("refs/heads/{branch}"),
        };
        let set_upstream = set_upstream && rev.is_none();
        let refspec = format!("{source}:refs/heads/{remote_branch}");
        let mut args = vec!["push"];
        if force {
            args.push("--force-with-lease");
        }
        if set_upstream {
            args.push("--set-upstream");
        }
        if tags {
            args.push("--follow-tags");
        }
        args.extend([remote, refspec.as_str()]);
        match self.git_write(&args, &[]) {
            Ok(_) => Ok(OpResult::ok_msg(match rev {
                Some(_) => format!("Pushed {branch} up to {} to {remote}/{remote_branch}", &source[..8]),
                None => format!("Pushed {branch} to {remote}/{remote_branch}"),
            })),
            Err((_, e)) if e.contains("[rejected]") || e.contains("non-fast-forward") || e.contains("fetch first") || e.contains("stale info") => {
                Ok(OpResult {
                    ok: false,
                    message: format!("Push of {branch} was rejected: {remote}/{remote_branch} has commits that are not in {branch}. Update the branch, then push again."),
                    conflicts: Vec::new(),
                    undo: Vec::new(),
                })
            }
            Err((_, e)) => Err(GitError(e)),
        }
    }

    /// Fast-forwards local branches that are not checked out to their tracked branches, as IntelliJ's
    /// Update Selected: `git fetch <remote> <branch>:<local>`. A branch whose tracked branch has other
    /// commits stays and is named in the message. Undo moves the branches back.
    pub fn fast_forward(&self, branches: &[String]) -> Result<OpResult> {
        let config = |key: String| self.git(&["config", "--get", &key]).ok().map(|b| String::from_utf8_lossy(&b).trim().to_string()).filter(|s| !s.is_empty());
        let mut undo = Vec::new();
        let (mut done, mut kept) = (Vec::new(), Vec::new());
        for b in branches {
            let b = safe(b)?;
            let full = format!("refs/heads/{b}");
            let (Some(remote), Some(merge)) = (config(format!("branch.{b}.remote")), config(format!("branch.{b}.merge"))) else {
                kept.push(format!("{b} (no tracked branch)"));
                continue;
            };
            let before = self.resolve(&full).unwrap_or_default();
            match self.git_write(&["fetch", "--no-tags", safe(&remote)?, &format!("{}:{full}", safe(&merge)?)], &[]) {
                Ok(_) => {
                    let after = self.resolve(&full).unwrap_or_default();
                    if after != before {
                        undo.push(UndoAction::MoveRef { name: full, to: before, expected: after });
                        done.push(b.to_string());
                    }
                }
                Err((_, e)) if e.contains("non-fast-forward") || e.contains("[rejected]") => kept.push(format!("{b} (it has commits that its tracked branch does not have)")),
                Err((_, e)) if e.contains("checked out") || e.contains("refusing to fetch") => kept.push(format!("{b} (it is checked out in a worktree)")),
                Err((_, e)) => kept.push(format!("{b} ({})", e.lines().last().unwrap_or("").trim())),
            }
        }
        let mut message = match done.len() {
            0 => "No branch moved".to_string(),
            1 => format!("Updated {}", done[0]),
            n => format!("Updated {n} branches"),
        };
        if !kept.is_empty() {
            message.push_str(&format!(". Not updated: {}", kept.join(", ")));
        }
        Ok(OpResult { ok: kept.is_empty(), message, conflicts: Vec::new(), undo })
    }

    /// Checkout and Rebase onto Current: checks out `branch` and rebases it onto `onto` (`git rebase onto
    /// branch`). Undo checks out the old branch again and moves `branch` back.
    pub fn checkout_rebase(&self, branch: &str, onto: &str) -> Result<OpResult> {
        let (branch, onto) = (safe(branch)?, safe(onto)?);
        let full = format!("refs/heads/{branch}");
        let before = self.resolve(&full).ok_or_else(|| GitError(format!("{branch} is not a local branch")))?;
        let back = self.state()?.branch;
        let pre_head = self.resolve("HEAD").unwrap_or_default();
        // Local changes go into a stash and come back after the rebase.
        match self.git_write(&["rebase", "--autostash", onto, branch], &[]) {
            Ok(_) => {
                let after = self.resolve(&full).unwrap_or_default();
                let target = back.unwrap_or(pre_head);
                let detach = self.git(&["rev-parse", "-q", "--verify", &format!("refs/heads/{target}")]).is_err();
                let undo = vec![
                    UndoAction::Checkout { target, detach, expected_head: after.clone() },
                    UndoAction::MoveRef { name: full, to: before, expected: after },
                ];
                Ok(OpResult { ok: true, message: format!("Checked out {branch} and rebased it onto {onto}"), conflicts: Vec::new(), undo })
            }
            Err((_, e)) => Ok(self.stopped("The rebase", e)),
        }
    }

    /// Updates the current branch from its tracked branch: fetch, then merge or rebase. Local changes are
    /// stashed and restored around the update, as IntelliJ does.
    pub fn update(&self, mode: UpdateMode) -> Result<OpResult> {
        self.update_with(mode, &UpdateOptions::default())
    }

    /// Update with the options of the Update dialog. The fast-forward options apply to a merge only.
    pub fn update_with(&self, mode: UpdateMode, o: &UpdateOptions) -> Result<OpResult> {
        let branch = self.current_branch()?;
        let (remote, remote_branch) =
            self.upstream_of(&branch).ok_or_else(|| GitError(format!("{branch} has no tracked branch. Push it with a tracked branch first")))?;
        let before = self.resolve("HEAD");
        let mut args = vec!["pull", "--autostash", "--no-edit"];
        args.push(if mode == UpdateMode::Rebase { "--rebase" } else { "--no-rebase" });
        if mode == UpdateMode::Merge {
            if o.ff_only {
                args.push("--ff-only");
            } else if o.no_ff {
                args.push("--no-ff");
            }
        }
        args.extend([safe(&remote)?, safe(&remote_branch)?]);
        let what = if mode == UpdateMode::Rebase { "Rebase" } else { "Merge" };
        match self.git_write(&args, &[("GIT_REFLOG_ACTION", "rebased-lite: update")]) {
            Ok(_) => {
                let after = self.resolve("HEAD");
                let message = if before == after {
                    format!("{branch} is up to date with {remote}/{remote_branch}")
                } else {
                    let n = match (&before, &after) {
                        (Some(b), Some(a)) => text(self.git(&["rev-list", "--count", &format!("{b}..{a}")])?).parse().unwrap_or(0),
                        _ => 0,
                    };
                    format!("Updated {branch} from {remote}/{remote_branch}: {n} new commit{}", if n == 1 { "" } else { "s" })
                };
                Ok(OpResult { ok: true, message, conflicts: Vec::new(), undo: Vec::new() })
            }
            Err((_, e)) if o.ff_only && e.contains("Not possible to fast-forward") => Ok(OpResult {
                ok: false,
                message: format!("{branch} cannot fast-forward to {remote}/{remote_branch}: it has commits of its own. Update with Merge or Rebase"),
                conflicts: Vec::new(),
                undo: Vec::new(),
            }),
            Err((_, e)) => Ok(self.stopped(what, e)),
        }
    }

    fn write(&self, args: &[&str], done: String) -> Result<OpResult> {
        self.git_write(args, &[]).map_err(|(out, e)| GitError(if out.is_empty() { e } else { format!("{e}\n{out}") }))?;
        Ok(OpResult::ok_msg(done))
    }

    /// The remotes with their URLs.
    pub fn remote_details(&self) -> Result<Vec<RemoteInfo>> {
        let mut out = Vec::new();
        for name in self.remotes()? {
            let fetch_url = self.config(&format!("remote.{name}.url")).unwrap_or_default();
            let push_url = self.config(&format!("remote.{name}.pushurl")).filter(|p| *p != fetch_url);
            out.push(RemoteInfo { name, fetch_url, push_url });
        }
        Ok(out)
    }

    pub fn add_remote(&self, name: &str, url: &str) -> Result<OpResult> {
        self.write(&["remote", "add", "--", safe(name)?, safe(url)?], format!("Added remote {name}"))
    }

    pub fn remove_remote(&self, name: &str) -> Result<OpResult> {
        self.write(&["remote", "remove", safe(name)?], format!("Removed remote {name} and its remote branches"))
    }

    pub fn rename_remote(&self, from: &str, to: &str) -> Result<OpResult> {
        self.write(&["remote", "rename", safe(from)?, safe(to)?], format!("Renamed remote {from} to {to}"))
    }

    /// Sets the URL of a remote. An empty push URL removes the separate push URL.
    pub fn set_remote_url(&self, name: &str, url: &str, push_url: &str) -> Result<OpResult> {
        let name = safe(name)?;
        self.git_write(&["remote", "set-url", "--", name, safe(url)?], &[]).map_err(|(_, e)| GitError(e))?;
        if push_url.trim().is_empty() {
            let _ = self.git_write(&["config", "--unset-all", &format!("remote.{name}.pushurl")], &[]);
        } else {
            self.git_write(&["remote", "set-url", "--push", "--", name, safe(push_url.trim())?], &[]).map_err(|(_, e)| GitError(e))?;
        }
        Ok(OpResult::ok_msg(format!("Changed the URL of {name}")))
    }

    /// Fetches one remote, and removes its remote branches that are gone.
    pub fn fetch_remote(&self, name: &str) -> Result<OpResult> {
        self.write(&["fetch", "--prune", safe(name)?], format!("Fetched {name}"))
    }

    /// Pushes a tag to a remote.
    pub fn push_tag(&self, remote: &str, tag: &str) -> Result<OpResult> {
        let spec = format!("refs/tags/{}:refs/tags/{tag}", safe(tag)?);
        self.write(&["push", safe(remote)?, &spec], format!("Pushed tag {tag} to {remote}"))
    }

    /// Pushes all local tags to a remote. A tag that the remote has with another commit is refused, and
    /// git names it.
    pub fn push_all_tags(&self, remote: &str) -> Result<OpResult> {
        self.write(&["push", safe(remote)?, "--tags"], format!("Pushed the tags to {remote}"))
    }

    /// The tags of a remote, from `git ls-remote`. It needs the network, like Fetch.
    pub fn remote_tags(&self, remote: &str) -> Result<Vec<String>> {
        let out = self.git_write(&["ls-remote", "--tags", "--refs", safe(remote)?], &[]).map_err(|(_, e)| GitError(e))?;
        Ok(out.lines().filter_map(|l| l.split_once('\t')?.1.strip_prefix("refs/tags/").map(String::from)).collect())
    }

    /// Deletes a tag or a branch on a remote. `name` is a full ref, for example `refs/tags/v1`.
    pub fn delete_remote_ref(&self, remote: &str, name: &str) -> Result<OpResult> {
        if !name.starts_with("refs/tags/") && !name.starts_with("refs/heads/") {
            return Err(GitError(format!("{name} is not a branch or a tag")));
        }
        let short = name.trim_start_matches("refs/tags/").trim_start_matches("refs/heads/");
        self.write(&["push", safe(remote)?, "--delete", name], format!("Deleted {short} from {remote}"))
    }

    /// Sets the tracked branch of a local branch, for example `origin/main`. None stops the tracking.
    pub fn set_upstream(&self, branch: &str, upstream: Option<&str>) -> Result<OpResult> {
        let branch = safe(branch)?;
        match upstream {
            Some(u) => {
                let arg = format!("--set-upstream-to={}", safe(u)?);
                self.write(&["branch", &arg, branch], format!("{branch} now tracks {u}"))
            }
            None => self.write(&["branch", "--unset-upstream", branch], format!("{branch} tracks no branch now")),
        }
    }

    /// The commits of `range` (for example `a..b`), newest first, at most MAX_OUTGOING.
    pub fn range_commits(&self, range: &str) -> Result<Vec<OutgoingCommit>> {
        let n = format!("-n{MAX_OUTGOING}");
        Ok(text(self.git(&["log", &n, "--format=%H%x1f%s%x1f%an%x1f%ct", range, "--"])?)
            .lines()
            .filter_map(|l| {
                let mut p = l.split('\x1f');
                Some(OutgoingCommit { oid: p.next()?.to_string(), subject: p.next()?.to_string(), author: p.next()?.to_string(), time: p.next()?.parse().ok()? })
            })
            .collect())
    }

    /// Compares two refs: the commits of each side that the other side does not have, and the commit
    /// that both sides start from.
    pub fn compare_refs(&self, left: &str, right: &str) -> Result<RefComparison> {
        let l = self.resolve(safe(left)?).ok_or_else(|| GitError(format!("{left} does not exist")))?;
        let r = self.resolve(safe(right)?).ok_or_else(|| GitError(format!("{right} does not exist")))?;
        let base = self.git(&["merge-base", &l, &r]).ok().map(text).filter(|s| !s.is_empty());
        Ok(RefComparison {
            only_left: self.range_commits(&format!("{r}..{l}"))?,
            only_right: self.range_commits(&format!("{l}..{r}"))?,
            left: l,
            right: r,
            base,
        })
    }
}

#[derive(Debug, Serialize)]
#[derive(ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct RefComparison {
    pub left: String,
    pub right: String,
    /// The best common ancestor; None when the histories do not meet.
    pub base: Option<String>,
    /// Commits in the left ref that the right ref does not have, newest first.
    pub only_left: Vec<OutgoingCommit>,
    pub only_right: Vec<OutgoingCommit>,
}

/// The options of the Update dialog for a merge.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UpdateOptions {
    /// Only a fast-forward (`git pull --ff-only`).
    pub ff_only: bool,
    /// Always a merge commit (`git pull --no-ff`).
    pub no_ff: bool,
}
