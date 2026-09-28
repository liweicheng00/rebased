//! Changelists: named groups of local changes, as in IntelliJ. A commit can take the files of one changelist
//! and leave the other local changes alone.
//!
//! The groups live in `<git dir>/rebased-lite/changelists.json`. Each worktree has its own git dir, so each
//! worktree has its own changelists. A changed file that is in no changelist goes to the active changelist
//! the first time it is seen. A file that is not changed any more leaves its changelist.

use crate::ops::OpResult;
use crate::{parse_name_status, Change, GitError, Repo, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

pub const DEFAULT_ID: &str = "default";
const DEFAULT_NAME: &str = "Changes";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredList {
    id: String,
    name: String,
    /// The draft commit message.
    #[serde(default)]
    comment: String,
    #[serde(default)]
    files: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Store {
    lists: Vec<StoredList>,
    active: String,
    #[serde(default)]
    next_id: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeListView {
    pub id: String,
    pub name: String,
    pub comment: String,
    pub active: bool,
    pub changes: Vec<Change>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalChanges {
    pub lists: Vec<ChangeListView>,
    /// Untracked files that are not ignored.
    pub unversioned: Vec<String>,
    /// Files with merge conflicts. They are also in a changelist, with status `U`.
    pub conflicts: Vec<String>,
    pub head: Option<String>,
}

/// A file that goes into a commit in part: the content to commit.
#[derive(Debug, Deserialize)]
pub struct PartialFile {
    pub path: String,
    pub content: String,
}

/// A change to the changelists.
#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ChangeListOp {
    Create { name: String, #[serde(default)] comment: String, #[serde(default)] make_active: bool, #[serde(default)] paths: Vec<String> },
    Edit { id: String, name: String, comment: String },
    Remove { id: String },
    SetActive { id: String },
    Move { paths: Vec<String>, to: String },
    SaveMessage { id: String, message: String },
}

impl Store {
    fn ensure_default(&mut self) {
        if self.lists.is_empty() {
            self.lists.push(StoredList { id: DEFAULT_ID.into(), name: DEFAULT_NAME.into(), comment: String::new(), files: Vec::new() });
        }
        if !self.lists.iter().any(|l| l.id == self.active) {
            self.active = self.lists[0].id.clone();
        }
    }

    fn list_mut(&mut self, id: &str) -> Result<&mut StoredList> {
        self.lists.iter_mut().find(|l| l.id == id).ok_or_else(|| GitError(format!("no changelist {id}")))
    }

    fn check_name(&self, name: &str, except: Option<&str>) -> Result<String> {
        let name = name.trim();
        if name.is_empty() {
            return Err(GitError("The changelist name is empty".into()));
        }
        if self.lists.iter().any(|l| Some(l.id.as_str()) != except && l.name == name) {
            return Err(GitError(format!("A changelist with the name {name:?} exists already")));
        }
        Ok(name.to_string())
    }

    fn remove_paths(&mut self, paths: &HashSet<&str>) {
        for l in &mut self.lists {
            l.files.retain(|f| !paths.contains(f.as_str()));
        }
    }
}

/// Rejects a path that leaves the repository.
fn inside(root: &Path, path: &str) -> Result<PathBuf> {
    let p = Path::new(path);
    if path.is_empty() || p.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(GitError(format!("invalid path {path:?}")));
    }
    Ok(root.join(p))
}

impl Repo {
    fn store_path(&self) -> PathBuf {
        self.git_dir().join("rebased-lite").join("changelists.json")
    }

    fn load_store(&self) -> Store {
        let mut store: Store = std::fs::read(self.store_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        store.ensure_default();
        store
    }

    fn save_store(&self, store: &Store) -> Result<()> {
        let path = self.store_path();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| GitError(e.to_string()))?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(store).unwrap_or_default()).map_err(|e| GitError(e.to_string()))?;
        std::fs::rename(&tmp, &path).map_err(|e| GitError(e.to_string()))
    }

    /// Tracked changes from HEAD to the working tree, with the staged changes included.
    fn tracked_changes(&self) -> Result<Vec<Change>> {
        let base = match self.resolve("HEAD") {
            Some(h) => h,
            None => self.empty_tree()?,
        };
        let raw = self.git(&["diff", "--name-status", "-M", "-z", &base])?;
        let mut changes = parse_name_status(&raw);
        let conflicts: HashSet<String> = self.conflicts().into_iter().collect();
        // An unmerged path can show twice; keep one entry with status U.
        let mut seen = HashSet::new();
        changes.retain(|c| seen.insert(c.path.clone()));
        for c in &mut changes {
            if conflicts.contains(&c.path) {
                c.status = 'U';
            }
        }
        for p in &conflicts {
            if !seen.contains(p) {
                changes.push(Change { status: 'U', path: p.clone(), old_path: None });
            }
        }
        changes.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(changes)
    }

    fn unversioned(&self) -> Result<Vec<String>> {
        let raw = self.git(&["ls-files", "--others", "--exclude-standard", "-z"])?;
        let mut out: Vec<String> =
            raw.split(|&b| b == 0).filter(|p| !p.is_empty()).map(|p| String::from_utf8_lossy(p).into_owned()).collect();
        out.sort();
        Ok(out)
    }

    /// The local changes by changelist. It assigns new changes to the active changelist and forgets files
    /// that are not changed any more.
    pub fn local_changes(&self) -> Result<LocalChanges> {
        let changes = self.tracked_changes()?;
        let unversioned = self.unversioned()?;
        let mut store = self.load_store();
        let changed: HashSet<&str> = changes.iter().map(|c| c.path.as_str()).collect();
        let mut dirty = false;
        let mut assigned = HashSet::new();
        for l in &mut store.lists {
            let before = l.files.len();
            // A file is in one changelist only: the first one wins.
            l.files.retain(|f| changed.contains(f.as_str()) && assigned.insert(f.clone()));
            dirty |= l.files.len() != before;
        }
        let active = store.active.clone();
        for c in &changes {
            if !assigned.contains(&c.path) {
                store.list_mut(&active)?.files.push(c.path.clone());
                dirty = true;
            }
        }
        if dirty {
            // A read-only git dir must not break the view.
            let _ = self.save_store(&store);
        }
        let lists = store
            .lists
            .iter()
            .map(|l| {
                let files: HashSet<&str> = l.files.iter().map(String::as_str).collect();
                ChangeListView {
                    id: l.id.clone(),
                    name: l.name.clone(),
                    comment: l.comment.clone(),
                    active: l.id == store.active,
                    changes: changes.iter().filter(|c| files.contains(c.path.as_str())).cloned().collect(),
                }
            })
            .collect();
        let conflicts = changes.iter().filter(|c| c.status == 'U').map(|c| c.path.clone()).collect();
        Ok(LocalChanges { lists, unversioned, conflicts, head: self.resolve("HEAD") })
    }

    pub fn changelist_op(&self, op: ChangeListOp) -> Result<()> {
        let mut store = self.load_store();
        match op {
            ChangeListOp::Create { name, comment, make_active, paths } => {
                let name = store.check_name(&name, None)?;
                store.next_id += 1;
                let id = format!("cl{}", store.next_id);
                store.remove_paths(&paths.iter().map(String::as_str).collect());
                store.lists.push(StoredList { id: id.clone(), name, comment, files: paths });
                if make_active {
                    store.active = id;
                }
            }
            ChangeListOp::Edit { id, name, comment } => {
                let name = store.check_name(&name, Some(&id))?;
                let l = store.list_mut(&id)?;
                l.name = name;
                l.comment = comment;
            }
            ChangeListOp::Remove { id } => {
                if store.lists.len() == 1 {
                    return Err(GitError("The last changelist cannot be removed".into()));
                }
                let i = store.lists.iter().position(|l| l.id == id).ok_or_else(|| GitError(format!("no changelist {id}")))?;
                let removed = store.lists.remove(i);
                if store.active == id {
                    store.active = store.lists[0].id.clone();
                }
                let active = store.active.clone();
                store.list_mut(&active)?.files.extend(removed.files);
            }
            ChangeListOp::SetActive { id } => {
                store.list_mut(&id)?;
                store.active = id;
            }
            ChangeListOp::Move { paths, to } => {
                store.list_mut(&to)?;
                store.remove_paths(&paths.iter().map(String::as_str).collect());
                store.list_mut(&to)?.files.extend(paths);
            }
            ChangeListOp::SaveMessage { id, message } => {
                store.list_mut(&id)?.comment = message;
            }
        }
        self.save_store(&store)
    }

    /// Commits the working-tree content of `paths` only, as IntelliJ does for a changelist. Other staged
    /// changes stay staged. `unversioned` files are added first. With `amend` and no paths, it changes
    /// only the message of the last commit. The commit hooks run.
    pub fn commit_paths(&self, paths: &[String], unversioned: &[String], message: &str, amend: bool) -> Result<OpResult> {
        if message.trim().is_empty() {
            return Err(GitError("The commit message is empty".into()));
        }
        if paths.is_empty() && unversioned.is_empty() && !amend {
            return Err(GitError("Select the files to commit".into()));
        }
        for p in paths.iter().chain(unversioned) {
            inside(&self.root, p)?;
        }
        let old_head = self.resolve("HEAD");
        if !unversioned.is_empty() {
            let mut args = vec!["add", "--"];
            args.extend(unversioned.iter().map(String::as_str));
            self.git_write(&args, &[]).map_err(|(_, e)| GitError(e))?;
        }
        // Git refuses a partial commit while a merge is in progress. Then the commit takes the whole index,
        // with the chosen files added, as IntelliJ does.
        let merging = self.git_dir().join("MERGE_HEAD").exists();
        if merging && !paths.is_empty() {
            let mut add = vec!["add", "-A", "--"];
            add.extend(paths.iter().map(String::as_str));
            self.git_write(&add, &[]).map_err(|(_, e)| GitError(e))?;
        }
        let mut args = vec!["commit", "--cleanup=strip", "-m", message];
        if amend {
            args.push("--amend");
        }
        if !merging {
            args.push("--only");
            if !paths.is_empty() || !unversioned.is_empty() {
                args.push("--");
                args.extend(paths.iter().chain(unversioned).map(String::as_str));
            }
        }
        self.git_write(&args, &[]).map_err(|(out, e)| GitError(if out.is_empty() { e } else { format!("{e}\n{out}") }))?;
        let head = self.resolve("HEAD").unwrap_or_default();
        let files = paths.len() + unversioned.len();
        let what = if amend { "Amended" } else { "Committed" };
        Ok(OpResult {
            ok: true,
            message: format!("{what} {} ({files} file{})", &head[..head.len().min(8)], if files == 1 { "" } else { "s" }),
            conflicts: Vec::new(),
            // A commit on an unborn branch has nothing to go back to.
            undo_to: old_head,
            undo_soft: true,
        })
    }

    /// Commits some files whole and some files in part, as IntelliJ does when you uncheck changes in the
    /// diff. `partial` gives the content to commit for each partly committed file. The commit is built in a
    /// temporary index, so the working tree and the other staged changes stay as they are; the index
    /// entries of the committed files are set to the new commit. Commit hooks do not run.
    pub fn commit_partial(&self, paths: &[String], unversioned: &[String], partial: &[PartialFile], message: &str, amend: bool) -> Result<OpResult> {
        if message.trim().is_empty() {
            return Err(GitError("The commit message is empty".into()));
        }
        if self.git_dir().join("MERGE_HEAD").exists() {
            return Err(GitError("A merge is in progress: commit whole files to finish it".into()));
        }
        for p in paths.iter().chain(unversioned).chain(partial.iter().map(|f| &f.path)) {
            inside(&self.root, p)?;
        }
        let old_head = self.resolve("HEAD");
        let tmp = self.git_dir().join("rebased-lite").join("index.partial");
        std::fs::create_dir_all(tmp.parent().unwrap()).map_err(|e| GitError(e.to_string()))?;
        let _ = std::fs::remove_file(&tmp);
        let tmp_s = tmp.to_string_lossy().into_owned();
        let env = [("GIT_INDEX_FILE", tmp_s.as_str())];
        let run = |args: &[&str]| self.git_write(args, &env).map_err(|(_, e)| GitError(e));
        let result = (|| {
            match &old_head {
                Some(h) => run(&["read-tree", h])?,
                None => run(&["read-tree", "--empty"])?,
            };
            let whole: Vec<&str> = paths.iter().chain(unversioned).map(String::as_str).collect();
            if !whole.is_empty() {
                let mut args = vec!["update-index", "--add", "--remove", "--"];
                args.extend(&whole);
                run(&args)?;
            }
            for f in partial {
                let blob = self.hash_object(&f.content)?;
                let mode = old_head
                    .as_ref()
                    .and_then(|h| self.git(&["ls-tree", h, "--", &f.path]).ok())
                    .map(|b| String::from_utf8_lossy(&b).split_whitespace().next().unwrap_or("100644").to_string())
                    .filter(|m| !m.is_empty())
                    .unwrap_or_else(|| "100644".into());
                run(&["update-index", "--add", "--cacheinfo", &format!("{mode},{blob},{}", f.path)])?;
            }
            let tree = run(&["write-tree"])?;
            let mut parents: Vec<String> = Vec::new();
            let mut author_env: Vec<(&str, String)> = Vec::new();
            if amend {
                let h = old_head.as_ref().ok_or_else(|| GitError("There is no commit to amend".into()))?;
                let m = self.meta(h)?;
                parents = m.parents.clone();
                author_env = vec![("GIT_AUTHOR_NAME", m.author_name), ("GIT_AUTHOR_EMAIL", m.author_email), ("GIT_AUTHOR_DATE", m.author_date)];
            } else if let Some(h) = &old_head {
                parents.push(h.clone());
            }
            let mut args = vec!["commit-tree".to_string(), tree, "-m".into(), message.trim_end().to_string()];
            for p in &parents {
                args.extend(["-p".to_string(), p.clone()]);
            }
            let argv: Vec<&str> = args.iter().map(String::as_str).collect();
            let envs: Vec<(&str, &str)> = author_env.iter().map(|(k, v)| (*k, v.as_str())).collect();
            let commit = self.git_write(&argv, &envs).map_err(|(_, e)| GitError(e))?;
            let subject = message.lines().next().unwrap_or("");
            let reflog = format!("commit{} (partial): {subject}", if amend { " (amend)" } else { "" });
            let mut upd = vec!["update-ref", "-m", reflog.as_str(), "HEAD", commit.as_str()];
            if let Some(h) = &old_head {
                upd.push(h.as_str());
            }
            self.git_write(&upd, &[]).map_err(|(_, e)| GitError(e))?;
            Ok(commit)
        })();
        let _ = std::fs::remove_file(&tmp);
        let commit = result?;
        // The real index gets the committed content of these files; the rest of the index stays.
        let mut all: Vec<&str> = paths.iter().chain(unversioned).map(String::as_str).collect();
        all.extend(partial.iter().map(|f| f.path.as_str()));
        let mut args = vec!["reset", "-q", "--"];
        args.extend(&all);
        let _ = self.git_write(&args, &[]);
        let files = all.len();
        Ok(OpResult {
            ok: true,
            message: format!(
                "{} {} ({files} file{}, {} in part)",
                if amend { "Amended" } else { "Committed" },
                &commit[..commit.len().min(8)],
                if files == 1 { "" } else { "s" },
                partial.len()
            ),
            conflicts: Vec::new(),
            undo_to: old_head,
            undo_soft: true,
        })
    }

    fn hash_object(&self, content: &str) -> Result<String> {
        use std::io::Write;
        let mut child = std::process::Command::new("git")
            .arg("-C")
            .arg(&self.root)
            .args(["hash-object", "-w", "--stdin"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| GitError(format!("cannot run git: {e}")))?;
        child.stdin.take().unwrap().write_all(content.as_bytes()).map_err(|e| GitError(e.to_string()))?;
        let out = child.wait_with_output().map_err(|e| GitError(e.to_string()))?;
        if !out.status.success() {
            return Err(GitError(String::from_utf8_lossy(&out.stderr).trim().to_string()));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    /// Discards the local changes of tracked files: the index and the working tree get the HEAD content.
    /// A file that is new in the index is removed.
    pub fn rollback(&self, paths: &[String]) -> Result<OpResult> {
        if paths.is_empty() {
            return Err(GitError("Select the files to roll back".into()));
        }
        for p in paths {
            inside(&self.root, p)?;
        }
        if self.resolve("HEAD").is_none() {
            let mut args = vec!["rm", "-q", "-f", "--cached", "--"];
            args.extend(paths.iter().map(String::as_str));
            self.git_write(&args, &[]).map_err(|(_, e)| GitError(e))?;
        } else {
            let mut args = vec!["restore", "--source=HEAD", "--staged", "--worktree", "--"];
            args.extend(paths.iter().map(String::as_str));
            self.git_write(&args, &[]).map_err(|(_, e)| GitError(e))?;
        }
        Ok(OpResult::ok_msg(format!("Rolled back {} file{}", paths.len(), if paths.len() == 1 { "" } else { "s" })))
    }

    /// Adds unversioned files to the index.
    pub fn add_files(&self, paths: &[String]) -> Result<OpResult> {
        for p in paths {
            inside(&self.root, p)?;
        }
        let mut args = vec!["add", "--"];
        args.extend(paths.iter().map(String::as_str));
        self.git_write(&args, &[]).map_err(|(_, e)| GitError(e))?;
        Ok(OpResult::ok_msg(format!("Added {} file{} to Git", paths.len(), if paths.len() == 1 { "" } else { "s" })))
    }

    /// Deletes unversioned files from the working tree. It refuses a tracked file.
    pub fn delete_unversioned(&self, paths: &[String]) -> Result<OpResult> {
        let untracked: HashSet<String> = self.unversioned()?.into_iter().collect();
        for p in paths {
            let full = inside(&self.root, p)?;
            if !untracked.contains(p) {
                return Err(GitError(format!("{p} is not an unversioned file")));
            }
            std::fs::remove_file(&full).map_err(|e| GitError(format!("{p}: {e}")))?;
        }
        Ok(OpResult::ok_msg(format!("Deleted {} file{}", paths.len(), if paths.len() == 1 { "" } else { "s" })))
    }

    /// The full message of HEAD, for Amend.
    pub fn head_message(&self) -> Result<String> {
        let raw = self.git(&["log", "-1", "--format=%B", "HEAD"])?;
        Ok(String::from_utf8_lossy(&raw).trim_end().to_string())
    }
}
