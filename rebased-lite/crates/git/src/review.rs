//! Review Branch: a local pull request. A review compares a branch with its base from the commit where
//! the branch started (the merge base), as a pull request does. The user marks files as viewed, adds
//! notes to lines, and then merges the branch into the base in one step.
//!
//! The reviews are in `<common git dir>/rebased-lite/reviews.json`, so all worktrees share them, and
//! nothing goes to a remote.

use crate::ops::{safe, OpResult};
use crate::remote::OutgoingCommit;
use crate::undo::{UndoAction, UndoMode};
use crate::{GitError, Repo, Result, Rev};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

/// A note on a line of the branch version of a file.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[derive(ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ReviewComment {
    pub id: String,
    pub path: String,
    /// The line in the branch version, 1-based.
    pub line: u32,
    pub text: String,
    pub time: i64,
    /// The blob of the file when the note was made.
    pub blob: String,
    /// The file changed since the note was made, so the line can be another line now. The list sets it.
    #[serde(default)]
    pub outdated: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    branch: String,
    base: String,
    created: i64,
    /// The path and the blob that the user saw. Another blob makes the file not viewed again.
    #[serde(default)]
    viewed: BTreeMap<String, String>,
    #[serde(default)]
    comments: Vec<ReviewComment>,
    /// Finish merged the branch. The branch can be gone then.
    #[serde(default)]
    finished: bool,
}

/// A review in the list.
#[derive(Clone, Debug, Serialize)]
#[derive(ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSummary {
    pub branch: String,
    pub base: String,
    /// The branch and the base exist.
    pub exists: bool,
    /// The base has all the commits of the branch.
    pub merged: bool,
    /// The commits of the branch that the base does not have.
    pub commits: usize,
    /// The commits of the base that the branch does not have.
    pub behind: usize,
    pub files: usize,
    pub viewed: usize,
    pub comments: usize,
    /// The files that conflict when the branch merges into the base.
    pub conflicts: Vec<String>,
    /// The subject and the time of the last commit of the branch.
    pub subject: String,
    pub time: i64,
}

#[derive(Clone, Debug, Serialize)]
#[derive(ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFile {
    pub status: char,
    pub path: String,
    pub old_path: Option<String>,
    pub viewed: bool,
    pub comments: usize,
}

#[derive(Clone, Debug, Serialize)]
#[derive(ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDetail {
    pub summary: ReviewSummary,
    pub head: String,
    pub base_oid: String,
    pub merge_base: String,
    /// The commits of the branch, newest first.
    pub commit_list: Vec<OutgoingCommit>,
    pub file_list: Vec<ReviewFile>,
    pub comment_list: Vec<ReviewComment>,
}

/// How Finish puts the branch into the base.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[derive(ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum FinishMode {
    /// A merge commit with the two parents.
    Merge,
    /// One new commit on the base with all the changes of the branch.
    Squash,
    /// The commits of the branch go on top of the base, and the base moves forward to them.
    Rebase,
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn text(b: Vec<u8>) -> String {
    String::from_utf8_lossy(&b).trim().to_string()
}

impl Repo {
    fn reviews_file(&self) -> PathBuf {
        self.common_dir().join("rebased-lite").join("reviews.json")
    }

    fn load_reviews(&self) -> Vec<Stored> {
        std::fs::read(self.reviews_file()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    fn save_reviews(&self, all: &[Stored]) -> Result<()> {
        let file = self.reviews_file();
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| GitError(e.to_string()))?;
        }
        let json = serde_json::to_vec_pretty(all).map_err(|e| GitError(e.to_string()))?;
        // Write a new file, then rename it, so a crash never leaves half a file.
        let tmp = file.with_extension("json.tmp");
        std::fs::write(&tmp, json).map_err(|e| GitError(e.to_string()))?;
        std::fs::rename(&tmp, &file).map_err(|e| GitError(e.to_string()))
    }

    fn edit_review<T>(&self, branch: &str, f: impl FnOnce(&mut Stored) -> Result<T>) -> Result<T> {
        let mut all = self.load_reviews();
        let r = all.iter_mut().find(|r| r.branch == branch).ok_or_else(|| GitError(format!("There is no review of {branch}")))?;
        let out = f(r)?;
        self.save_reviews(&all)?;
        Ok(out)
    }

    fn branch_oid(&self, name: &str) -> Option<String> {
        self.resolve(&format!("refs/heads/{name}"))
    }

    /// Starts a review of `branch` against `base`, or changes the base of a review.
    pub fn start_review(&self, branch: &str, base: &str) -> Result<()> {
        if branch == base {
            return Err(GitError("The branch and the base must be different".into()));
        }
        for b in [branch, base] {
            self.branch_oid(safe(b)?).ok_or_else(|| GitError(format!("{b} is not a local branch")))?;
        }
        let mut all = self.load_reviews();
        match all.iter_mut().find(|r| r.branch == branch) {
            Some(r) => r.base = base.to_string(),
            None => all.push(Stored { branch: branch.into(), base: base.into(), created: now(), ..Stored::default() }),
        }
        self.save_reviews(&all)
    }

    /// Removes a review and its notes. The branch stays.
    pub fn remove_review(&self, branch: &str) -> Result<()> {
        let mut all = self.load_reviews();
        all.retain(|r| r.branch != branch);
        self.save_reviews(&all)
    }

    /// The blobs of the files at a commit; a deleted file has none.
    fn blobs(&self, commit: &str, paths: &[String]) -> HashMap<String, String> {
        if paths.is_empty() {
            return HashMap::new();
        }
        let mut args = vec!["ls-tree", "-r", "-z", commit, "--"];
        args.extend(paths.iter().map(String::as_str));
        let out = self.git(&args).unwrap_or_default();
        String::from_utf8_lossy(&out)
            .split('\0')
            .filter_map(|e| {
                let (meta, path) = e.split_once('\t')?;
                Some((path.to_string(), meta.split_whitespace().nth(2)?.to_string()))
            })
            .collect()
    }

    /// The files that conflict when `head` merges into `base`. Git 2.38 or later.
    fn merge_conflicts(&self, base: &str, head: &str) -> Vec<String> {
        match self.git_write(&["merge-tree", "--write-tree", "--name-only", "--no-messages", base, head], &[]) {
            Ok(_) => Vec::new(),
            Err((out, _)) => out.lines().skip(1).take_while(|l| !l.is_empty()).map(String::from).collect(),
        }
    }

    fn count(&self, range: &str) -> usize {
        self.git(&["rev-list", "--count", range]).map(text).ok().and_then(|s| s.parse().ok()).unwrap_or(0)
    }

    fn review_detail(&self, s: &Stored) -> Result<ReviewDetail> {
        let (Some(head), Some(base_oid)) = (self.branch_oid(&s.branch), self.branch_oid(&s.base)) else {
            let summary = ReviewSummary {
                branch: s.branch.clone(),
                base: s.base.clone(),
                exists: false,
                merged: s.finished,
                commits: 0,
                behind: 0,
                files: 0,
                viewed: 0,
                comments: s.comments.len(),
                conflicts: Vec::new(),
                subject: String::new(),
                time: 0,
            };
            return Ok(ReviewDetail {
                summary,
                head: String::new(),
                base_oid: String::new(),
                merge_base: String::new(),
                commit_list: Vec::new(),
                file_list: Vec::new(),
                comment_list: s.comments.clone(),
            });
        };
        let merge_base = self.git(&["merge-base", &base_oid, &head]).map(text).unwrap_or_default();
        let changes = if merge_base.is_empty() { Vec::new() } else { self.list_changes(&Rev::Commit(merge_base.clone()), &Rev::Commit(head.clone()))? };
        let paths: Vec<String> = changes.iter().map(|c| c.path.clone()).collect();
        let blobs = self.blobs(&head, &paths);
        let blob_of = |p: &str| blobs.get(p).cloned().unwrap_or_else(|| "deleted".into());
        let comments: Vec<ReviewComment> =
            s.comments.iter().map(|c| ReviewComment { outdated: blob_of(&c.path) != c.blob, ..c.clone() }).collect();
        let file_list: Vec<ReviewFile> = changes
            .into_iter()
            .map(|c| ReviewFile {
                viewed: s.viewed.get(&c.path).is_some_and(|b| *b == blob_of(&c.path)),
                comments: comments.iter().filter(|x| x.path == c.path).count(),
                status: c.status,
                path: c.path,
                old_path: c.old_path,
            })
            .collect();
        let commit_list = self.range_commits(&format!("{base_oid}..{head}"))?;
        let tip = self.git(&["show", "-s", "--format=%s%x00%ct", &head]).map(text).unwrap_or_default();
        let (subject, time) = tip.split_once('\0').unwrap_or((&tip, "0"));
        let summary = ReviewSummary {
            branch: s.branch.clone(),
            base: s.base.clone(),
            exists: true,
            merged: self.git(&["merge-base", "--is-ancestor", &head, &base_oid]).is_ok(),
            commits: commit_list.len(),
            behind: self.count(&format!("{head}..{base_oid}")),
            files: file_list.len(),
            viewed: file_list.iter().filter(|f| f.viewed).count(),
            comments: comments.len(),
            conflicts: self.merge_conflicts(&base_oid, &head),
            subject: subject.to_string(),
            time: time.parse().unwrap_or(0),
        };
        Ok(ReviewDetail { summary, head, base_oid, merge_base, commit_list, file_list, comment_list: comments })
    }

    /// The reviews, the last made first.
    pub fn reviews(&self) -> Result<Vec<ReviewSummary>> {
        let mut all = self.load_reviews();
        all.sort_by(|a, b| b.created.cmp(&a.created));
        all.iter().map(|s| self.review_detail(s).map(|d| d.summary)).collect()
    }

    pub fn review(&self, branch: &str) -> Result<ReviewDetail> {
        let all = self.load_reviews();
        let s = all.iter().find(|r| r.branch == branch).ok_or_else(|| GitError(format!("There is no review of {branch}")))?;
        self.review_detail(s)
    }

    /// Marks files as viewed at the current version of the branch, or as not viewed.
    pub fn set_viewed(&self, branch: &str, paths: &[String], viewed: bool) -> Result<()> {
        let head = self.branch_oid(branch).ok_or_else(|| GitError(format!("{branch} is not a local branch")))?;
        let blobs = self.blobs(&head, paths);
        self.edit_review(branch, |r| {
            for p in paths {
                if viewed {
                    r.viewed.insert(p.clone(), blobs.get(p).cloned().unwrap_or_else(|| "deleted".into()));
                } else {
                    r.viewed.remove(p);
                }
            }
            Ok(())
        })
    }

    pub fn add_review_comment(&self, branch: &str, path: &str, line: u32, text: &str) -> Result<()> {
        if text.trim().is_empty() {
            return Err(GitError("The note is empty".into()));
        }
        let head = self.branch_oid(branch).ok_or_else(|| GitError(format!("{branch} is not a local branch")))?;
        let blob = self.blobs(&head, &[path.to_string()]).remove(path).unwrap_or_else(|| "deleted".into());
        self.edit_review(branch, |r| {
            let n = r.comments.iter().filter_map(|c| c.id.parse::<u64>().ok()).max().unwrap_or(0) + 1;
            r.comments.push(ReviewComment { id: n.to_string(), path: path.into(), line, text: text.trim().into(), time: now(), blob, outdated: false });
            Ok(())
        })
    }

    pub fn delete_review_comment(&self, branch: &str, id: &str) -> Result<()> {
        self.edit_review(branch, |r| {
            r.comments.retain(|c| c.id != id);
            Ok(())
        })
    }

    /// The branches that a worktree other than this one has checked out.
    fn checked_out_elsewhere(&self) -> Vec<String> {
        let here = std::fs::canonicalize(&self.root).unwrap_or(self.root.clone());
        let out = self.git(&["for-each-ref", "--format=%(refname:lstrip=2)%00%(worktreepath)", "refs/heads"]).unwrap_or_default();
        String::from_utf8_lossy(&out)
            .lines()
            .filter_map(|l| {
                let (name, path) = l.split_once('\0')?;
                (!path.is_empty() && std::fs::canonicalize(path).unwrap_or(PathBuf::from(path)) != here).then(|| name.to_string())
            })
            .collect()
    }

    /// A commit with these parents and the tree, by the current user. It is signed when commits are.
    fn new_commit(&self, tree: &str, parents: &[&str], message: &str) -> Result<String> {
        let mut args = vec!["commit-tree", tree, "-m", message];
        for p in parents {
            args.extend(["-p", p]);
        }
        if self.signs_commits() {
            args.push("-S");
        }
        self.git_write(&args, &[]).map_err(|(_, e)| GitError(e))
    }

    /// The commits of the branch on top of `onto`, without the working tree.
    fn rebase_in_memory(&self, merge_base: &str, head: &str, onto: &str) -> Result<String> {
        let list = self.git(&["rev-list", "--reverse", "--topo-order", &format!("{merge_base}..{head}")]).map(text)?;
        let mut tip = onto.to_string();
        for oid in list.lines() {
            let meta = self.meta(oid)?;
            if meta.parents.len() > 1 {
                return Err(GitError(format!("The branch has a merge commit ({}). Use Merge or Squash", &oid[..8])));
            }
            let parent = meta.parents.first().cloned().unwrap_or_default();
            let tree = self.merge_tree(&parent, &tip, oid, oid)?;
            tip = self.commit_tree(&tree, &tip, &meta, &meta.message)?;
        }
        Ok(tip)
    }

    fn move_ref(&self, name: &str, new: &str, old: &str, why: &str) -> Result<()> {
        let full = format!("refs/heads/{name}");
        self.git_write(&["update-ref", "-m", why, &full, new, old], &[]).map(|_| ()).map_err(|(_, e)| GitError(e))
    }

    /// Puts the branch into its base, and marks the review as done by that. Merge and Squash use
    /// `message`. The working tree changes only when the base or the branch is checked out here. When
    /// `delete_branch` is set, the branch goes away after it is merged. Undo puts back the base and the
    /// branch.
    pub fn finish_review(&self, branch: &str, mode: FinishMode, message: &str, delete_branch: bool) -> Result<OpResult> {
        let all = self.load_reviews();
        let s = all.iter().find(|r| r.branch == branch).ok_or_else(|| GitError(format!("There is no review of {branch}")))?;
        let base = s.base.clone();
        let head = self.branch_oid(branch).ok_or_else(|| GitError(format!("{branch} is not a local branch")))?;
        let base_old = self.branch_oid(&base).ok_or_else(|| GitError(format!("{base} is not a local branch")))?;
        if self.git(&["merge-base", "--is-ancestor", &head, &base_old]).is_ok() {
            return Err(GitError(format!("{base} already has all the commits of {branch}")));
        }
        let elsewhere = self.checked_out_elsewhere();
        if let Some(b) = [&base, &branch.to_string()].into_iter().find(|b| elsewhere.contains(b)) {
            return Err(GitError(format!("Another worktree has {b} checked out. Finish the review there")));
        }
        if matches!(mode, FinishMode::Merge | FinishMode::Squash) && message.trim().is_empty() {
            return Err(GitError("The commit message is empty".into()));
        }
        let current = self.state()?.branch;
        let on_base = current.as_deref() == Some(base.as_str());
        let on_branch = current.as_deref() == Some(branch);
        // A merge or a commit here would take the staged changes of the user with it.
        if (on_base || (on_branch && mode == FinishMode::Rebase)) && self.git(&["diff", "--cached", "--quiet"]).is_err() {
            return Err(GitError("The index has staged changes. Commit or unstage them first".into()));
        }
        let before_config = self.config_local();
        let why = format!("rebased-lite: finish the review of {branch}");
        let reflog = [("GIT_REFLOG_ACTION", why.as_str())];
        let merge_base = self.git(&["merge-base", &base_old, &head]).map(text)?;

        let stop = |what: &str, e: String| Ok(self.stopped(what, e));
        match mode {
            FinishMode::Merge | FinishMode::Squash if on_base => {
                let r = if mode == FinishMode::Merge {
                    self.git_write(&["merge", "--no-ff", "-m", message, safe(branch)?], &reflog)
                } else {
                    self.git_write(&["merge", "--squash", safe(branch)?], &reflog).and_then(|_| self.git_write(&["commit", "-q", "-m", message], &reflog))
                };
                if let Err((_, e)) = r {
                    return stop("The merge", e);
                }
            }
            FinishMode::Merge | FinishMode::Squash => {
                let conflicts = self.merge_conflicts(&base_old, &head);
                if !conflicts.is_empty() {
                    return Err(GitError(format!(
                        "{} file(s) conflict: {}. Check out {base} and finish there to resolve them",
                        conflicts.len(),
                        conflicts.join(", ")
                    )));
                }
                let tree = self.git_write(&["merge-tree", "--write-tree", &base_old, &head], &[]).map_err(|(_, e)| GitError(e))?;
                let tree = tree.lines().next().unwrap_or_default().to_string();
                let parents: Vec<&str> = if mode == FinishMode::Merge { vec![&base_old, &head] } else { vec![&base_old] };
                let commit = self.new_commit(&tree, &parents, message)?;
                self.move_ref(&base, &commit, &base_old, &why)?;
            }
            FinishMode::Rebase => {
                // First the branch goes on top of the base.
                let tip = if merge_base == base_old {
                    head.clone()
                } else if on_branch {
                    if let Err((_, e)) = self.git_write(&["rebase", &base], &reflog) {
                        return stop("The rebase", e);
                    }
                    self.branch_oid(branch).unwrap_or_default()
                } else {
                    let tip = self.rebase_in_memory(&merge_base, &head, &base_old)?;
                    self.move_ref(branch, &tip, &head, &why)?;
                    tip
                };
                // Then the base moves forward.
                if on_base {
                    if let Err((_, e)) = self.git_write(&["merge", "--ff-only", &tip], &reflog) {
                        return stop("The fast-forward", e);
                    }
                } else {
                    self.move_ref(&base, &tip, &base_old, &why)?;
                }
            }
        }

        let mut note = String::new();
        if delete_branch {
            if on_branch {
                note = format!(". {branch} stays because it is checked out");
            } else {
                self.git_write(&["branch", "-D", "--", branch], &[]).map_err(|(_, e)| GitError(e))?;
            }
        }

        // Undo from the state before and after.
        let mut undo = Vec::new();
        let head_now = self.resolve("HEAD").unwrap_or_default();
        let restore = |name: &str, old: &str, undo: &mut Vec<UndoAction>| {
            let full = format!("refs/heads/{name}");
            match self.branch_oid(name) {
                None => undo.push(UndoAction::CreateRef { name: full, oid: old.to_string() }),
                Some(new) if new != old => {
                    if current.as_deref() == Some(name) {
                        undo.push(UndoAction::Reset { to: old.to_string(), expected_head: head_now.clone(), mode: UndoMode::Keep });
                    } else {
                        undo.push(UndoAction::DeleteRef { name: full.clone(), expected: new });
                        undo.push(UndoAction::CreateRef { name: full, oid: old.to_string() });
                    }
                }
                _ => {}
            }
        };
        restore(&base, &base_old, &mut undo);
        restore(branch, &head, &mut undo);
        let after_config = self.config_local();
        for (k, v) in &before_config {
            if after_config.get(k) != Some(v) {
                undo.push(UndoAction::SetConfig { key: k.clone(), values: v.clone() });
            }
        }
        let _ = self.edit_review(branch, |r| {
            r.finished = true;
            Ok(())
        });
        let how = match mode {
            FinishMode::Merge => "Merged",
            FinishMode::Squash => "Squashed",
            FinishMode::Rebase => "Rebased and fast-forwarded",
        };
        Ok(OpResult { ok: true, message: format!("{how} {branch} into {base}{note}"), conflicts: Vec::new(), undo })
    }
}
