//! Write operations. Every command runs the git CLI without a terminal or an editor, so it never waits for input.
//! The in-memory rewrites are in `rewrite`, and Undo is in `undo`.

pub use crate::rewrite::{parse_author, Action, PlanEntry, RangeCommit, RewriteRange};
pub use crate::undo::{UndoAction, UndoMode};
use crate::{GitError, Repo, Result};
use serde::{Deserialize, Serialize};

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
    /// What Undo does, in order. Empty when the operation cannot be undone.
    pub undo: Vec<UndoAction>,
}

impl OpResult {
    pub fn ok_msg(message: impl Into<String>) -> OpResult {
        Self::ok(message)
    }

    pub(crate) fn ok(message: impl Into<String>) -> OpResult {
        OpResult { ok: true, message: message.into(), conflicts: Vec::new(), undo: Vec::new() }
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

/// Rejects a name or revision that git could read as an option.
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
        let mut cmd = crate::git_command();
        cmd.arg("-C").arg(&self.root).args(args);
        cmd.env("GIT_TERMINAL_PROMPT", "0").env("GIT_EDITOR", "true").env("GIT_SEQUENCE_EDITOR", "true").env("LC_ALL", "C");
        cmd.envs(crate::network_env());
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
        let mut child = crate::git_command()
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
                        undo: Vec::new(),
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

    /// The directory with the refs and objects; for a linked worktree it is the main repository's git dir.
    pub fn common_dir(&self) -> std::path::PathBuf {
        let raw = self.git(&["rev-parse", "--path-format=absolute", "--git-common-dir"]).unwrap_or_default();
        std::path::PathBuf::from(String::from_utf8_lossy(&raw).trim())
    }

    pub fn git_dir(&self) -> std::path::PathBuf {
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
        OpResult { ok: false, message, conflicts, undo: Vec::new() }
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
        self.run(&["reset", flag, safe(to)?, "--"], &format!("Reset to {}", &to[..to.len().min(8)]))
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

}
