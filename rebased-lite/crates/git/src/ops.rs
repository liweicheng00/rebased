//! Write operations. Every command runs the git CLI without a terminal or an editor, so it never waits for input.
//!
//! Commit rewrites (squash, fixup, drop, reword, reorder) run in memory, like IntelliJ's in-memory rebase:
//! `git merge-tree --write-tree` replays each commit and `git commit-tree` writes it, so the working tree is
//! not touched. When the final tree differs from HEAD, `git reset --keep` moves the branch; it refuses to run
//! when a local change would be lost. A conflict stops the rewrite before any ref changes.

use crate::{GitError, Repo, Result};
use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoState {
    /// none, merge, rebase, cherry-pick, revert
    pub operation: &'static str,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub conflicts: Vec<String>,
    /// Number of changed or untracked files in the working tree.
    pub changed_files: usize,
    /// The commit where an interactive rebase stopped for editing.
    pub editing: Option<String>,
    /// The branch that a rebase in progress rewrites.
    pub rebasing: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpResult {
    pub ok: bool,
    pub message: String,
    /// Files with conflicts when the operation stopped.
    pub conflicts: Vec<String>,
    /// HEAD before a rewrite or a commit, for Undo.
    pub undo_to: Option<String>,
    /// Undo keeps the changes of the undone commits as local changes (`git reset --soft`).
    pub undo_soft: bool,
}

impl OpResult {
    pub fn ok_msg(message: impl Into<String>) -> OpResult {
        Self::ok(message)
    }

    fn ok(message: impl Into<String>) -> OpResult {
        OpResult { ok: true, message: message.into(), conflicts: Vec::new(), undo_to: None, undo_soft: false }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ResetMode {
    Soft,
    Mixed,
    Hard,
    Keep,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Pick,
    Reword,
    /// Stop at this commit, so the user can change it. Only a real `git rebase -i` can stop.
    Edit,
    Squash,
    Fixup,
    Drop,
}

/// One line of a rewrite plan, oldest commit first.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanEntry {
    pub oid: String,
    pub action: Action,
    /// New message for reword, or the combined message for the first commit of a squash group.
    #[serde(default)]
    pub message: Option<String>,
}

/// The commits from `base` (exclusive) to HEAD, oldest first, ready for a rewrite.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RewriteRange {
    pub base: String,
    pub entries: Vec<RangeCommit>,
    /// Some commits are on a remote branch already; a rewrite needs a force push.
    pub published: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RangeCommit {
    pub oid: String,
    pub subject: String,
    pub message: String,
    pub author: String,
}

/// Rejects a name or revision that git could read as an option.
/// Quotes a string for the POSIX shell that git uses to run editors and exec lines.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

pub(crate) fn safe(arg: &str) -> Result<&str> {
    if arg.is_empty() || arg.starts_with('-') {
        Err(GitError(format!("invalid name or revision: {arg:?}")))
    } else {
        Ok(arg)
    }
}

pub(crate) struct CommitMeta {
    pub(crate) parents: Vec<String>,
    pub(crate) tree: String,
    pub(crate) author_name: String,
    pub(crate) author_email: String,
    pub(crate) author_date: String,
    pub(crate) message: String,
}

impl Repo {
    /// Runs git for a write operation. It never prompts and never opens an editor.
    pub(crate) fn git_write(&self, args: &[&str], env: &[(&str, &str)]) -> std::result::Result<String, (String, String)> {
        let mut cmd = Command::new("git");
        cmd.arg("-C").arg(&self.root).args(args);
        cmd.env("GIT_TERMINAL_PROMPT", "0").env("GIT_EDITOR", "true").env("GIT_SEQUENCE_EDITOR", "true").env("LC_ALL", "C");
        for (k, v) in env {
            cmd.env(k, v);
        }
        let out = cmd.output().map_err(|e| (String::new(), format!("cannot run git: {e}")))?;
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if out.status.success() {
            Ok(if stdout.is_empty() { stderr } else { stdout })
        } else {
            Err((stdout, if stderr.is_empty() { format!("git {} failed", args.join(" ")) } else { stderr }))
        }
    }

    fn run(&self, args: &[&str], done: &str) -> Result<OpResult> {
        match self.git_write(args, &[]) {
            Ok(_) => Ok(OpResult::ok(done)),
            Err((_, e)) => Err(GitError(e)),
        }
    }

    /// Runs git with `input` on stdin. It never prompts.
    pub(crate) fn git_stdin(&self, args: &[&str], input: &[u8]) -> std::result::Result<String, String> {
        use std::io::Write;
        let mut child = Command::new("git")
            .arg("-C")
            .arg(&self.root)
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("cannot run git: {e}"))?;
        let mut stdin = child.stdin.take().unwrap();
        let data = input.to_vec();
        // Write on a thread, so a large input cannot block against a full stdout pipe.
        let writer = std::thread::spawn(move || stdin.write_all(&data));
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        let _ = writer.join();
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if out.status.success() {
            Ok(stdout)
        } else {
            Err(if stderr.is_empty() { stdout } else { stderr })
        }
    }

    /// Applies the change of some files between two commits to the working tree, as IntelliJ's
    /// Cherry-Pick Selected Changes; with `reverse`, it removes that change, as Revert Selected Changes.
    /// A change that does not apply cleanly falls back to a three-way merge and can leave conflicts; the
    /// three-way merge needs the files to match the index.
    pub fn apply_file_changes(&self, from: &str, to: &str, paths: &[String], reverse: bool) -> Result<OpResult> {
        let (from, to) = (safe(from)?, safe(to)?);
        for p in paths {
            safe(p)?;
        }
        let mut args = vec!["diff", "--binary", "--full-index", "-M", from, to, "--"];
        args.extend(paths.iter().map(String::as_str));
        let patch = self.git(&args)?;
        if patch.is_empty() {
            return Err(GitError("The selected files have no changes".into()));
        }
        let what = if reverse { "Reverted" } else { "Applied" };
        // A plain apply changes only the working tree, so local changes in the same files are fine.
        let mut plain = vec!["apply"];
        if reverse {
            plain.push("-R");
        }
        if self.git_stdin(&plain, &patch).is_ok() {
            return Ok(OpResult::ok_msg(format!("{what} the changes of {} file(s)", paths.len())));
        }
        let mut apply = vec!["apply", "--3way"];
        if reverse {
            apply.push("-R");
        }
        match self.git_stdin(&apply, &patch) {
            Ok(_) => Ok(OpResult::ok_msg(format!("{what} the changes of {} file(s)", paths.len()))),
            Err(e) => {
                let conflicts = self.conflicts();
                if conflicts.is_empty() {
                    Err(GitError(e))
                } else {
                    Ok(OpResult {
                        ok: false,
                        message: format!("The changes applied with conflicts in {} file(s). Resolve them.", conflicts.len()),
                        conflicts,
                        undo_to: None,
                        undo_soft: false,
                    })
                }
            }
        }
    }

    /// Replaces files in the working tree and the index with their version in a revision. A file that
    /// does not exist in the revision is deleted.
    pub fn get_from_revision(&self, rev: &str, paths: &[String]) -> Result<OpResult> {
        let rev = safe(rev)?;
        let source = format!("--source={rev}");
        let mut args = vec!["restore", source.as_str(), "--staged", "--worktree", "--"];
        args.extend(paths.iter().map(String::as_str));
        self.git_write(&args, &[]).map_err(|(_, e)| GitError(e))?;
        Ok(OpResult::ok_msg(format!("Got {} file(s) from {}", paths.len(), &rev[..rev.len().min(8)])))
    }

    pub(crate) fn git_dir(&self) -> std::path::PathBuf {
        let raw = self.git(&["rev-parse", "--absolute-git-dir"]).unwrap_or_default();
        std::path::PathBuf::from(String::from_utf8_lossy(&raw).trim())
    }

    pub fn state(&self) -> Result<RepoState> {
        let dir = self.git_dir();
        let operation = if dir.join("rebase-merge").exists() || dir.join("rebase-apply").exists() {
            "rebase"
        } else if dir.join("MERGE_HEAD").exists() {
            "merge"
        } else if dir.join("CHERRY_PICK_HEAD").exists() {
            "cherry-pick"
        } else if dir.join("REVERT_HEAD").exists() {
            "revert"
        } else {
            "none"
        };
        let conflicts = self.conflicts();
        let status = self.git(&["status", "--porcelain=v1", "-z"])?;
        let changed_files = status.split(|&b| b == 0).filter(|p| p.len() > 3).count();
        let branch = self.git(&["symbolic-ref", "-q", "--short", "HEAD"]).ok().map(|b| String::from_utf8_lossy(&b).trim().to_string());
        let editing = std::fs::read_to_string(dir.join("rebase-merge").join("amend")).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let rebasing = ["rebase-merge", "rebase-apply"]
            .iter()
            .find_map(|d| std::fs::read_to_string(dir.join(d).join("head-name")).ok())
            .map(|s| s.trim().trim_start_matches("refs/heads/").to_string())
            .filter(|s| !s.is_empty() && s != "detached HEAD");
        Ok(RepoState { operation, branch, head: self.resolve("HEAD"), conflicts, changed_files, editing, rebasing })
    }

    pub(crate) fn conflicts(&self) -> Vec<String> {
        self.git(&["diff", "--name-only", "--diff-filter=U", "-z"])
            .map(|b| b.split(|&c| c == 0).filter(|p| !p.is_empty()).map(|p| String::from_utf8_lossy(p).into_owned()).collect())
            .unwrap_or_default()
    }

    pub(crate) fn stopped(&self, what: &str, err: String) -> OpResult {
        let conflicts = self.conflicts();
        let message = if conflicts.is_empty() {
            err
        } else {
            format!("{what} stopped with conflicts in {} file(s). Resolve them, then continue, or abort.", conflicts.len())
        };
        OpResult { ok: false, message, conflicts, undo_to: None, undo_soft: false }
    }

    // ---- branches and refs ----

    /// Checks out a local branch, creates a tracking branch for a remote branch, or detaches HEAD at a commit.
    pub fn checkout(&self, target: &str, kind: &str) -> Result<OpResult> {
        match kind {
            "local" => self.run(&["checkout", safe(target)?, "--"], &format!("Checked out {target}")),
            "remote" => {
                let local = target.split_once('/').map_or(target, |(_, b)| b);
                let exists = self.git(&["rev-parse", "-q", "--verify", &format!("refs/heads/{local}")]).is_ok();
                if exists {
                    self.run(&["checkout", safe(local)?, "--"], &format!("Checked out {local}"))
                } else {
                    self.run(&["checkout", "-b", safe(local)?, "--track", safe(target)?, "--"], &format!("Created {local} tracking {target}"))
                }
            }
            _ => self.run(&["checkout", "--detach", safe(target)?, "--"], &format!("HEAD is now at {}", &target[..target.len().min(8)])),
        }
    }

    pub fn create_branch(&self, name: &str, at: &str, checkout: bool) -> Result<OpResult> {
        self.check_ref_name(&format!("refs/heads/{name}"))?;
        if checkout {
            self.run(&["checkout", "-b", safe(name)?, safe(at)?, "--"], &format!("Created and checked out {name}"))
        } else {
            self.run(&["branch", safe(name)?, safe(at)?], &format!("Created branch {name}"))
        }
    }

    pub fn create_tag(&self, name: &str, at: &str, message: &str) -> Result<OpResult> {
        self.check_ref_name(&format!("refs/tags/{name}"))?;
        if message.trim().is_empty() {
            self.run(&["tag", safe(name)?, safe(at)?], &format!("Created tag {name}"))
        } else {
            self.run(&["tag", "-a", "-m", message, safe(name)?, safe(at)?], &format!("Created tag {name}"))
        }
    }

    fn check_ref_name(&self, full: &str) -> Result<()> {
        self.git(&["check-ref-format", full]).map(|_| ()).map_err(|_| GitError(format!("{} is not a valid name", full.rsplit('/').next().unwrap_or(full))))
    }

    pub fn rename_branch(&self, from: &str, to: &str) -> Result<OpResult> {
        self.check_ref_name(&format!("refs/heads/{to}"))?;
        self.run(&["branch", "-m", safe(from)?, safe(to)?], &format!("Renamed {from} to {to}"))
    }

    /// Deletes a local branch. Without `force`, git refuses when the branch is not merged.
    pub fn delete_branch(&self, name: &str, force: bool) -> Result<OpResult> {
        self.run(&["branch", if force { "-D" } else { "-d" }, safe(name)?], &format!("Deleted branch {name}"))
    }

    pub fn delete_tag(&self, name: &str) -> Result<OpResult> {
        self.run(&["tag", "-d", safe(name)?], &format!("Deleted tag {name}"))
    }

    // ---- operations that use the working tree ----

    pub fn merge(&self, rev: &str) -> Result<OpResult> {
        match self.git_write(&["merge", "--no-edit", safe(rev)?], &[]) {
            Ok(out) => Ok(OpResult::ok(if out.contains("Already up to date") { "Already up to date".to_string() } else { format!("Merged {rev}") })),
            Err((_, e)) => Ok(self.stopped("The merge", e)),
        }
    }

    pub fn rebase(&self, onto: &str) -> Result<OpResult> {
        match self.git_write(&["rebase", safe(onto)?], &[]) {
            Ok(_) => Ok(OpResult::ok(format!("Rebased onto {onto}"))),
            Err((_, e)) => Ok(self.stopped("The rebase", e)),
        }
    }

    /// Applies commits oldest first.
    pub fn cherry_pick(&self, oids: &[String]) -> Result<OpResult> {
        let mut args = vec!["cherry-pick"];
        for o in oids {
            args.push(safe(o)?);
        }
        match self.git_write(&args, &[]) {
            Ok(_) => Ok(OpResult::ok(format!("Cherry-picked {} commit(s)", oids.len()))),
            Err((_, e)) => Ok(self.stopped("The cherry-pick", e)),
        }
    }

    /// Reverts commits newest first, each as its own commit.
    pub fn revert(&self, oids: &[String]) -> Result<OpResult> {
        let mut args = vec!["revert", "--no-edit"];
        for o in oids {
            args.push(safe(o)?);
        }
        match self.git_write(&args, &[]) {
            Ok(_) => Ok(OpResult::ok(format!("Reverted {} commit(s)", oids.len()))),
            Err((_, e)) => Ok(self.stopped("The revert", e)),
        }
    }

    pub fn reset(&self, to: &str, mode: ResetMode) -> Result<OpResult> {
        let flag = match mode {
            ResetMode::Soft => "--soft",
            ResetMode::Mixed => "--mixed",
            ResetMode::Hard => "--hard",
            ResetMode::Keep => "--keep",
        };
        let before = self.resolve("HEAD");
        let mut r = self.run(&["reset", flag, safe(to)?, "--"], &format!("Reset to {}", &to[..to.len().min(8)]))?;
        r.undo_to = before;
        Ok(r)
    }

    /// Continues or aborts the operation in progress.
    pub fn continue_or_abort(&self, abort: bool) -> Result<OpResult> {
        let op = self.state()?.operation;
        let verb = if abort { "--abort" } else { "--continue" };
        let args: Vec<&str> = match op {
            "rebase" => vec!["rebase", verb],
            "merge" => vec!["merge", verb],
            "cherry-pick" => vec!["cherry-pick", verb],
            "revert" => vec!["revert", verb],
            _ => return Err(GitError("No merge, rebase, cherry-pick or revert is in progress".into())),
        };
        if !abort && !self.conflicts().is_empty() {
            return Err(GitError("Resolve the conflicts and stage the files first".into()));
        }
        match self.git_write(&args, &[]) {
            Ok(_) => Ok(OpResult::ok(format!("{} the {op}", if abort { "Aborted" } else { "Continued" }))),
            Err((_, e)) => Ok(self.stopped(&format!("The {op}"), e)),
        }
    }

    /// Stages the resolved files so the operation can continue.
    pub fn mark_resolved(&self, paths: &[String]) -> Result<OpResult> {
        let mut args = vec!["add", "--"];
        args.extend(paths.iter().map(String::as_str));
        self.run(&args, &format!("Marked {} file(s) as resolved", paths.len()))
    }

    // ---- in-memory rewrite ----

    pub(crate) fn meta(&self, oid: &str) -> Result<CommitMeta> {
        let raw = self.git(&["show", "-s", "--format=%P%x00%T%x00%an%x00%ae%x00%ad%x00%B", "--date=raw", oid])?;
        let text = String::from_utf8_lossy(&raw);
        let f: Vec<&str> = text.splitn(6, '\0').collect();
        if f.len() < 6 {
            return Err(GitError(format!("cannot read commit {oid}")));
        }
        Ok(CommitMeta {
            parents: f[0].split_whitespace().map(String::from).collect(),
            tree: f[1].to_string(),
            author_name: f[2].to_string(),
            author_email: f[3].to_string(),
            author_date: f[4].to_string(),
            message: f[5].trim_end().to_string(),
        })
    }

    /// The commits after `base` on the current branch. Merges in the range are not supported.
    pub fn rewrite_range(&self, base: &str) -> Result<RewriteRange> {
        let state = self.state()?;
        if state.operation != "none" {
            return Err(GitError(format!("Finish or abort the {} first", state.operation)));
        }
        if state.branch.is_none() {
            return Err(GitError("HEAD is detached. Check out a branch first".into()));
        }
        let base = self.resolve(base).ok_or_else(|| GitError(format!("unknown commit {base}")))?;
        if self.git(&["merge-base", "--is-ancestor", &base, "HEAD"]).is_err() {
            return Err(GitError("The commits are not on the current branch".into()));
        }
        let raw = self.git(&["rev-list", "--reverse", "--parents", &format!("{base}..HEAD")])?;
        let mut entries = Vec::new();
        for line in String::from_utf8_lossy(&raw).lines() {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() != 2 {
                return Err(GitError("The range contains a merge commit. Rewriting merges is not supported".into()));
            }
            let m = self.meta(parts[0])?;
            entries.push(RangeCommit {
                oid: parts[0].to_string(),
                subject: m.message.lines().next().unwrap_or("").to_string(),
                message: m.message,
                author: m.author_name,
            });
        }
        let published = match entries.first() {
            Some(first) => self
                .git(&["branch", "-r", "--contains", &first.oid, "--format=%(refname)"])
                .map(|b| !String::from_utf8_lossy(&b).trim().is_empty())
                .unwrap_or(false),
            None => false,
        };
        Ok(RewriteRange { base, entries, published })
    }

    /// Replays `plan` on `base` in memory and moves the current branch to the result.
    pub fn rewrite(&self, base: &str, plan: &[PlanEntry], what: &str) -> Result<OpResult> {
        let range = self.rewrite_range(base)?;
        let mut expected: Vec<&str> = range.entries.iter().map(|e| e.oid.as_str()).collect();
        let mut given: Vec<&str> = plan.iter().map(|e| e.oid.as_str()).collect();
        expected.sort_unstable();
        given.sort_unstable();
        if expected != given {
            return Err(GitError("The plan must list every commit of the range exactly once".into()));
        }
        if plan.iter().find(|e| e.action != Action::Drop).is_some_and(|e| matches!(e.action, Action::Squash | Action::Fixup)) {
            return Err(GitError("A squash or fixup needs a commit before it".into()));
        }
        if plan.iter().any(|e| e.action == Action::Edit) {
            return self.rebase_interactive(&range.base, plan, what);
        }
        let old_head = self.resolve("HEAD").ok_or_else(|| GitError("no HEAD".into()))?;
        let branch = self.state()?.branch.unwrap_or_default();

        let mut current = range.base.clone();
        let mut current_tree = self.meta(&current)?.tree;
        let mut last: Option<(String, CommitMeta, String)> = None; // (parent, first meta, message)
        let mut unchanged = true;
        for e in plan {
            if e.action == Action::Drop {
                unchanged = false;
                continue;
            }
            let m = self.meta(&e.oid)?;
            let parent = m.parents.first().cloned().unwrap_or_default();
            let tree = if parent == current && unchanged {
                m.tree.clone()
            } else {
                self.merge_tree(&parent, &current, &e.oid, &e.oid)?
            };
            match e.action {
                Action::Squash | Action::Fixup => {
                    let (grand, first, msg) = last.take().expect("checked above");
                    let message = match (&e.message, e.action) {
                        (Some(custom), _) => custom.clone(),
                        (None, Action::Squash) => format!("{msg}\n\n{}", m.message),
                        _ => msg,
                    };
                    current = self.commit_tree(&tree, &grand, &first, &message)?;
                    unchanged = false;
                    last = Some((grand, first, message));
                }
                _ => {
                    let message = e.message.clone().unwrap_or_else(|| m.message.clone());
                    if unchanged && parent == current && message == m.message {
                        current = e.oid.clone();
                    } else {
                        current = self.commit_tree(&tree, &current, &m, &message)?;
                        unchanged = false;
                    }
                    let parent_of_new = self.meta(&current)?.parents.first().cloned().unwrap_or_default();
                    last = Some((parent_of_new, m, message));
                }
            }
            current_tree = tree;
        }
        if current == old_head {
            return Ok(OpResult::ok("Nothing changed"));
        }
        let head_tree = self.meta(&old_head)?.tree;
        let reflog = format!("rebased-lite: {what}");
        let moved = if head_tree == current_tree {
            self.git_write(&["update-ref", "-m", &reflog, &format!("refs/heads/{branch}"), &current, &old_head], &[])
        } else {
            self.git_write(&["reset", "--keep", &current], &[("GIT_REFLOG_ACTION", &reflog)])
        };
        if let Err((_, e)) = moved {
            return Err(GitError(format!("The branch was not changed: {e}")));
        }
        Ok(OpResult { ok: true, message: format!("{what} done"), conflicts: Vec::new(), undo_to: Some(old_head), undo_soft: false })
    }

    /// Runs a real `git rebase -i` with the plan as its todo list, for a plan that stops to edit a commit.
    /// New messages are set with `exec git commit --amend` lines. Local changes are stashed and restored.
    fn rebase_interactive(&self, base: &str, plan: &[PlanEntry], what: &str) -> Result<OpResult> {
        let old_head = self.resolve("HEAD").ok_or_else(|| GitError("no HEAD".into()))?;
        let dir = self.git_dir().join("rebased-lite");
        std::fs::create_dir_all(&dir).map_err(|e| GitError(e.to_string()))?;
        let mut todo = String::new();
        let mut group_message: Option<&str> = None;
        for (i, e) in plan.iter().enumerate() {
            let word = match e.action {
                Action::Pick | Action::Reword => "pick",
                Action::Edit => "edit",
                Action::Squash => "squash",
                Action::Fixup => "fixup",
                Action::Drop => "drop",
            };
            todo.push_str(&format!("{word} {}\n", e.oid));
            if e.action == Action::Drop {
                continue;
            }
            if let Some(m) = e.message.as_deref() {
                group_message = Some(m);
            }
            // At the end of a squash group, set the chosen message.
            let group_ends = !plan[i + 1..].iter().find(|n| n.action != Action::Drop).is_some_and(|n| matches!(n.action, Action::Squash | Action::Fixup));
            if group_ends {
                if let Some(m) = group_message.take() {
                    let file = dir.join(format!("message-{i}.txt"));
                    std::fs::write(&file, m).map_err(|e| GitError(e.to_string()))?;
                    todo.push_str(&format!("exec git commit --amend --allow-empty -q -F {}\n", shell_quote(&file.to_string_lossy())));
                }
            }
        }
        let todo_file = dir.join("rebase-todo.txt");
        std::fs::write(&todo_file, todo).map_err(|e| GitError(e.to_string()))?;
        let editor = format!("cp {}", shell_quote(&todo_file.to_string_lossy()));
        let reflog = format!("rebased-lite: {what}");
        let env = [("GIT_SEQUENCE_EDITOR", editor.as_str()), ("GIT_REFLOG_ACTION", reflog.as_str())];
        let result = self.git_write(&["rebase", "-i", "--autostash", base], &env);
        let state = self.state()?;
        match result {
            Ok(_) if state.operation == "rebase" => {
                let at = state.editing.clone().or(state.head.clone()).unwrap_or_default();
                Ok(OpResult {
                    ok: true,
                    message: format!(
                        "The rebase stopped at {} for editing. Change the files, amend the commit in the Commit tab, then continue.",
                        &at[..at.len().min(8)]
                    ),
                    conflicts: Vec::new(),
                    undo_to: None,
                    undo_soft: false,
                })
            }
            Ok(_) => Ok(OpResult { ok: true, message: format!("{what} done"), conflicts: Vec::new(), undo_to: Some(old_head), undo_soft: false }),
            Err((_, e)) => Ok(self.stopped("The rebase", e)),
        }
    }

    /// Moves the current branch back after a rewrite, if nothing moved it since.
    /// With `soft`, the changes of the undone commits stay as local changes, as IntelliJ's Undo Commit does.
    pub fn undo(&self, to: &str, expected_head: &str, soft: bool) -> Result<OpResult> {
        if self.resolve("HEAD").as_deref() != Some(expected_head) {
            return Err(GitError("HEAD changed since the operation. Undo is not possible".into()));
        }
        if soft {
            return self
                .git_write(&["reset", "--soft", safe(to)?], &[("GIT_REFLOG_ACTION", "rebased-lite: undo commit")])
                .map(|_| OpResult::ok("Undone. The changes are local changes again"))
                .map_err(|(_, e)| GitError(e));
        }
        let old_tree = self.meta(to)?.tree;
        let head_tree = self.meta(expected_head)?.tree;
        let branch = self.state()?.branch.ok_or_else(|| GitError("HEAD is detached".into()))?;
        let r = if old_tree == head_tree {
            self.git_write(&["update-ref", "-m", "rebased-lite: undo", &format!("refs/heads/{branch}"), to, expected_head], &[])
        } else {
            self.git_write(&["reset", "--keep", to], &[("GIT_REFLOG_ACTION", "rebased-lite: undo")])
        };
        r.map(|_| OpResult::ok("Undone")).map_err(|(_, e)| GitError(e))
    }

    /// Applies the change `base -> commit` on top of `onto` without touching the working tree.
    fn merge_tree(&self, base: &str, onto: &str, commit: &str, label: &str) -> Result<String> {
        let args = if base.is_empty() {
            vec!["merge-tree".to_string(), "--write-tree".into(), "--allow-unrelated-histories".into(), onto.into(), commit.into()]
        } else {
            vec!["merge-tree".to_string(), "--write-tree".into(), format!("--merge-base={base}"), onto.into(), commit.into()]
        };
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        match self.git_write(&argv, &[]) {
            Ok(out) => Ok(out.lines().next().unwrap_or("").to_string()),
            Err((out, _)) => {
                let files: Vec<&str> = out.lines().skip(1).filter_map(|l| l.split('\t').nth(1)).collect();
                let mut files = files;
                files.dedup();
                Err(GitError(format!(
                    "Commit {} conflicts with the new history ({}). Nothing was changed",
                    &label[..label.len().min(8)],
                    if files.is_empty() { "unknown files".into() } else { files.join(", ") }
                )))
            }
        }
    }

    fn commit_tree(&self, tree: &str, parent: &str, author: &CommitMeta, message: &str) -> Result<String> {
        let env = [
            ("GIT_AUTHOR_NAME", author.author_name.as_str()),
            ("GIT_AUTHOR_EMAIL", author.author_email.as_str()),
            ("GIT_AUTHOR_DATE", author.author_date.as_str()),
        ];
        let mut args = vec!["commit-tree", tree, "-m", message];
        if !parent.is_empty() {
            args.extend(["-p", parent]);
        }
        self.git_write(&args, &env).map_err(|(_, e)| GitError(e))
    }
}
