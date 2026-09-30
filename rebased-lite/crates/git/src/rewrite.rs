//! Commit rewrites (squash, fixup, drop, reword, reorder, author) run in memory, like IntelliJ's in-memory
//! rebase: `git merge-tree --write-tree` replays each commit and `git commit-tree` writes it, so the working
//! tree is not touched. When the final tree differs from HEAD, `git reset --keep` moves the branch; it
//! refuses to run when a local change would be lost. A conflict stops the rewrite before any ref changes.
//! A plan with an Edit step runs a real `git rebase -i` instead.

use crate::ops::{CommitMeta, OpResult};
use crate::undo::{UndoAction, UndoMode};
use crate::{GitError, Repo, Result};
use serde::{Deserialize, Serialize};

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
    /// A new author, as "Name <email>". The author date stays.
    #[serde(default)]
    pub author: Option<String>,
}

/// Splits "Name <email>" into the name and the email.
pub fn parse_author(s: &str) -> Result<(String, String)> {
    let s = s.trim();
    let (name, rest) = s.split_once('<').ok_or_else(|| GitError(format!("The author must be \"Name <email>\": {s}")))?;
    let email = rest.strip_suffix('>').ok_or_else(|| GitError(format!("The author must be \"Name <email>\": {s}")))?;
    let (name, email) = (name.trim(), email.trim());
    if name.is_empty() || email.is_empty() || email.contains(['<', '>']) {
        return Err(GitError(format!("The author must be \"Name <email>\": {s}")));
    }
    Ok((name.to_string(), email.to_string()))
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
    pub author_email: String,
}


/// Quotes a string for the POSIX shell that git uses to run editors and exec lines.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

impl Repo {
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
                author_email: m.author_email,
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
                    let mut m = m;
                    let mut new_author = false;
                    if let Some(a) = &e.author {
                        let (name, email) = parse_author(a)?;
                        new_author = name != m.author_name || email != m.author_email;
                        m.author_name = name;
                        m.author_email = email;
                    }
                    if unchanged && parent == current && message == m.message && !new_author {
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
        let undo = vec![UndoAction::Reset { to: old_head, expected_head: current, mode: UndoMode::Keep }];
        Ok(OpResult { ok: true, message: format!("{what} done"), conflicts: Vec::new(), undo })
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
                    undo: Vec::new(),
                })
            }
            Ok(_) => {
                let head = state.head.clone().unwrap_or_default();
                let undo = vec![UndoAction::Reset { to: old_head, expected_head: head, mode: UndoMode::Keep }];
                Ok(OpResult { ok: true, message: format!("{what} done"), conflicts: Vec::new(), undo })
            }
            Err((_, e)) => Ok(self.stopped("The rebase", e)),
        }
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
        if self.signs_commits() {
            args.push("-S");
        }
        self.git_write(&args, &env).map_err(|(_, e)| GitError(e))
    }

    /// `commit.gpgsign` is on. git commit signs by itself, but git commit-tree signs only with `-S`; it then
    /// uses `user.signingkey` and `gpg.format` like git commit.
    pub(crate) fn signs_commits(&self) -> bool {
        self.git(&["config", "--type=bool", "commit.gpgsign"]).is_ok_and(|b| String::from_utf8_lossy(&b).trim() == "true")
    }
}
