//! Undo: the steps that bring the repository back after an operation.

use crate::ops::{safe, OpResult};
use crate::{GitError, Repo, Result};
use serde::{Deserialize, Serialize};

/// How Undo moves the branch back.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[derive(ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum UndoMode {
    /// The files of the undone commits change back; local changes stay (`git reset --keep`).
    Keep,
    /// The undone commits become local changes (`git reset --soft`).
    Soft,
    /// The index gets the old commit; the working tree does not change (`git reset --mixed`).
    Mixed,
}

/// One step of an Undo. Each step checks that the repository did not change since the operation.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[derive(ts_rs::TS)]
#[ts(export)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum UndoAction {
    Reset { to: String, expected_head: String, mode: UndoMode },
    /// Checks out a branch, or detaches HEAD at a commit.
    Checkout { target: String, detach: bool, expected_head: String },
    /// Creates a ref that the operation deleted.
    CreateRef { name: String, oid: String },
    /// Deletes a ref that the operation created.
    DeleteRef { name: String, expected: String },
    RenameBranch { from: String, to: String },
    /// Puts a dropped stash back.
    StashStore { oid: String, message: String },
}


impl Repo {
    /// Moves the current branch back after a rewrite, if nothing moved it since.
    /// With `soft`, the changes of the undone commits stay as local changes, as IntelliJ's Undo Commit does.
    pub fn undo(&self, to: &str, expected_head: &str, soft: bool) -> Result<OpResult> {
        let mode = if soft { UndoMode::Soft } else { UndoMode::Keep };
        self.apply_undo(&[UndoAction::Reset { to: to.into(), expected_head: expected_head.into(), mode }])
    }

    /// Runs the steps of an Undo in order. It stops at the first step whose check fails.
    pub fn apply_undo(&self, actions: &[UndoAction]) -> Result<OpResult> {
        const ZERO: &str = "0000000000000000000000000000000000000000";
        let reflog = [("GIT_REFLOG_ACTION", "rebased-lite: undo")];
        let head_is = |expected: &str| -> Result<()> {
            if self.resolve("HEAD").as_deref() == Some(expected) {
                Ok(())
            } else {
                Err(GitError("HEAD changed since the operation. Undo is not possible".into()))
            }
        };
        let mut message = "Undone".to_string();
        for a in actions {
            let r = match a {
                UndoAction::Reset { to, expected_head, mode } => {
                    head_is(expected_head)?;
                    let to = safe(to)?;
                    match mode {
                        UndoMode::Soft => {
                            message = "Undone. The changes are local changes again".into();
                            self.git_write(&["reset", "--soft", to], &reflog)
                        }
                        UndoMode::Mixed => self.git_write(&["reset", "--mixed", "-q", to], &reflog),
                        UndoMode::Keep => {
                            let branch = self.state()?.branch;
                            // The same tree: move the ref only, so nothing in the working tree changes.
                            if branch.is_some() && self.meta(to)?.tree == self.meta(expected_head)?.tree {
                                let r = format!("refs/heads/{}", branch.unwrap_or_default());
                                self.git_write(&["update-ref", "-m", "rebased-lite: undo", &r, to, expected_head], &[])
                            } else {
                                self.git_write(&["reset", "--keep", to], &reflog)
                            }
                        }
                    }
                }
                UndoAction::Checkout { target, detach, expected_head } => {
                    head_is(expected_head)?;
                    if *detach {
                        self.git_write(&["checkout", "--detach", safe(target)?, "--"], &reflog)
                    } else {
                        self.git_write(&["checkout", safe(target)?, "--"], &reflog)
                    }
                }
                UndoAction::CreateRef { name, oid } => self.git_write(&["update-ref", "-m", "rebased-lite: undo", safe(name)?, safe(oid)?, ZERO], &[]),
                UndoAction::DeleteRef { name, expected } => self.git_write(&["update-ref", "-d", safe(name)?, safe(expected)?], &[]),
                UndoAction::RenameBranch { from, to } => self.git_write(&["branch", "-m", safe(from)?, safe(to)?], &[]),
                UndoAction::StashStore { oid, message: m } => self.git_write(&["stash", "store", "-m", m, safe(oid)?], &[]),
            };
            r.map_err(|(_, e)| GitError(format!("Undo stopped: {e}")))?;
        }
        Ok(OpResult::ok(message))
    }
}
