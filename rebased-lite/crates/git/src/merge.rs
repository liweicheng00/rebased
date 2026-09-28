//! Conflict resolution: the three versions of a conflicted file, and saving the result.

use crate::ops::OpResult;
use crate::{GitError, Repo, Result, MAX_TEXT_SIZE};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeSide {
    /// None when the side does not have the file (it was deleted or never existed there).
    pub text: Option<String>,
    pub label: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeSides {
    pub path: String,
    pub base: MergeSide,
    /// The current branch side ("yours").
    pub ours: MergeSide,
    /// The incoming side ("theirs").
    pub theirs: MergeSide,
    /// A side is binary or larger than the text limit: only a whole side can be taken.
    pub binary: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Side {
    Ours,
    Theirs,
}

impl Repo {
    fn stage(&self, n: u8, path: &str) -> Option<Vec<u8>> {
        self.git(&["show", &format!(":{n}:{path}")]).ok()
    }

    fn first_line(&self, file: &str) -> Option<String> {
        let s = std::fs::read_to_string(self.git_dir().join(file)).ok()?;
        s.lines().next().map(|l| l.trim().to_string()).filter(|l| !l.is_empty())
    }

    fn describe(&self, rev: &str) -> Option<String> {
        let raw = self.git(&["log", "-1", "--format=%h %s", rev]).ok()?;
        let s = String::from_utf8_lossy(&raw).trim().to_string();
        (!s.is_empty()).then_some(s)
    }

    /// Labels for the two sides, from the operation in progress.
    fn side_labels(&self) -> (String, String) {
        let dir = self.git_dir();
        let head = self
            .git(&["symbolic-ref", "-q", "--short", "HEAD"])
            .ok()
            .map(|b| String::from_utf8_lossy(&b).trim().to_string())
            .filter(|s| !s.is_empty());
        if dir.join("rebase-merge").exists() || dir.join("rebase-apply").exists() {
            let onto = self.first_line("rebase-merge/onto").or_else(|| self.first_line("rebase-apply/onto"));
            let ours = onto.and_then(|o| self.describe(&o)).map_or("Rebase base".to_string(), |d| format!("Rebase base: {d}"));
            let theirs = self.describe("REBASE_HEAD").map_or("Your commit".to_string(), |d| format!("Your commit: {d}"));
            return (ours, theirs);
        }
        let ours = head.map_or("Yours (HEAD)".to_string(), |b| format!("Yours ({b})"));
        if dir.join("MERGE_HEAD").exists() {
            let msg = self.first_line("MERGE_MSG").unwrap_or_default();
            let name = msg
                .strip_prefix("Merge branch '")
                .or_else(|| msg.strip_prefix("Merge remote-tracking branch '"))
                .and_then(|r| r.split('\'').next())
                .map(String::from)
                .or_else(|| self.describe("MERGE_HEAD"));
            return (ours, format!("Theirs ({})", name.unwrap_or_else(|| "MERGE_HEAD".into())));
        }
        if dir.join("CHERRY_PICK_HEAD").exists() {
            return (ours, self.describe("CHERRY_PICK_HEAD").map_or("Theirs (cherry-pick)".into(), |d| format!("Theirs: {d}")));
        }
        if dir.join("REVERT_HEAD").exists() {
            return (ours, self.describe("REVERT_HEAD").map_or("Theirs (revert)".into(), |d| format!("Revert of {d}")));
        }
        (ours, "Theirs (stashed changes)".into())
    }

    /// The base, your and their version of a conflicted file.
    pub fn merge_sides(&self, path: &str) -> Result<MergeSides> {
        if !self.conflicts().iter().any(|p| p == path) {
            return Err(GitError(format!("{path} has no conflict")));
        }
        let (ours_label, theirs_label) = self.side_labels();
        let stages = [self.stage(1, path), self.stage(2, path), self.stage(3, path)];
        let binary = stages.iter().flatten().any(|b| b.len() > MAX_TEXT_SIZE || b.iter().take(8000).any(|&c| c == 0));
        let text = |b: &Option<Vec<u8>>| if binary { None } else { b.as_ref().map(|b| String::from_utf8_lossy(b).into_owned()) };
        Ok(MergeSides {
            path: path.to_string(),
            base: MergeSide { text: text(&stages[0]), label: "Base".into() },
            ours: MergeSide { text: text(&stages[1]), label: ours_label },
            theirs: MergeSide { text: text(&stages[2]), label: theirs_label },
            binary,
        })
    }

    /// Writes the merged text to the working tree and marks the file resolved.
    pub fn resolve_with_text(&self, path: &str, text: &str) -> Result<OpResult> {
        if !self.conflicts().iter().any(|p| p == path) {
            return Err(GitError(format!("{path} has no conflict")));
        }
        std::fs::write(self.root.join(path), text).map_err(|e| GitError(format!("{path}: {e}")))?;
        self.git_write(&["add", "--", path], &[]).map_err(|(_, e)| GitError(e))?;
        Ok(OpResult::ok_msg(format!("Resolved {path}")))
    }

    /// Takes one whole side. When that side deleted the file, the file is removed.
    pub fn resolve_with_side(&self, paths: &[String], side: Side) -> Result<OpResult> {
        let conflicts = self.conflicts();
        for path in paths {
            if !conflicts.contains(path) {
                return Err(GitError(format!("{path} has no conflict")));
            }
            let stage = if side == Side::Ours { 2 } else { 3 };
            if self.stage(stage, path).is_some() {
                let flag = if side == Side::Ours { "--ours" } else { "--theirs" };
                self.git_write(&["checkout", flag, "--", path], &[]).map_err(|(_, e)| GitError(e))?;
                self.git_write(&["add", "--", path], &[]).map_err(|(_, e)| GitError(e))?;
            } else {
                self.git_write(&["rm", "-q", "--", path], &[]).map_err(|(_, e)| GitError(e))?;
            }
        }
        let which = if side == Side::Ours { "yours" } else { "theirs" };
        Ok(OpResult::ok_msg(format!("Resolved {} file(s) with {which}", paths.len())))
    }
}
