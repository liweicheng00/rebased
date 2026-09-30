//! Watches a repository for changes made outside the app: files in the working tree, and refs, HEAD
//! and the index in the git directory. The front end polls the two counters and reloads what changed.
//!
//! On Linux, inotify needs one watch per directory, and the number of watches is limited. So the watcher
//! adds a watch for each directory that git does not ignore. Elsewhere it watches the root recursively.

use crate::history::{LocalHistory, MAX_BULK_FILES};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Counters that go up when something changed.
#[derive(Default)]
pub struct WatchState {
    /// Commits, refs, HEAD or an operation in progress changed.
    pub repo: AtomicU64,
    /// Files in the working tree or the index changed.
    pub files: AtomicU64,
}

#[derive(Serialize, Clone, Copy)]
#[derive(ts_rs::TS)]
#[ts(export)]
pub struct WatchCounters {
    pub repo: u64,
    pub files: u64,
}

impl WatchState {
    pub fn counters(&self) -> WatchCounters {
        WatchCounters { repo: self.repo.load(Ordering::SeqCst), files: self.files.load(Ordering::SeqCst) }
    }
}

/// Gets the counters after a change.
pub type OnChange = Arc<dyn Fn(WatchCounters) + Send + Sync>;

pub struct RepoWatcher {
    pub state: Arc<WatchState>,
    // Dropping the watcher stops the events; the worker thread then ends.
    _watcher: Arc<Mutex<RecommendedWatcher>>,
}

const DEBOUNCE: Duration = Duration::from_millis(300);

/// Files in the git dir that change what the log, the refs or the operation banner show.
fn is_repo_file(rel: &Path) -> bool {
    let first = rel.components().next().map(|c| c.as_os_str().to_string_lossy().into_owned()).unwrap_or_default();
    matches!(
        first.as_str(),
        "HEAD" | "refs" | "packed-refs" | "MERGE_HEAD" | "CHERRY_PICK_HEAD" | "REVERT_HEAD" | "REBASE_HEAD" | "rebase-merge" | "rebase-apply" | "logs" | "FETCH_HEAD" | "ORIG_HEAD"
    )
}

impl RepoWatcher {
    /// Starts to watch. When `history` is set, each changed file gets a version in Local History.
    /// `on_change` gets the counters after each change.
    pub fn start(
        root: &Path,
        git_dir: &Path,
        common_dir: &Path,
        history: Option<Arc<LocalHistory>>,
        on_change: Option<OnChange>,
    ) -> notify::Result<RepoWatcher> {
        let state = Arc::new(WatchState::default());
        let (tx, rx) = channel::<notify::Result<Event>>();
        let watcher = Arc::new(Mutex::new(notify::recommended_watcher(tx)?));
        {
            let mut w = watcher.lock().unwrap();
            for dir in [git_dir, common_dir] {
                // The git dir itself: HEAD, the index, MERGE_HEAD and the other state files.
                let _ = w.watch(dir, RecursiveMode::NonRecursive);
                let _ = w.watch(&dir.join("refs"), RecursiveMode::Recursive);
                let _ = w.watch(&dir.join("logs"), RecursiveMode::NonRecursive);
            }
            if cfg!(target_os = "linux") {
                for d in worktree_dirs(root) {
                    if w.watch(&d, RecursiveMode::NonRecursive).is_err() {
                        break; // Out of inotify watches: the focus refresh still works.
                    }
                }
            } else {
                w.watch(root, RecursiveMode::Recursive)?;
            }
        }
        let worker = Worker {
            root: root.to_path_buf(),
            git_dir: git_dir.to_path_buf(),
            common_dir: common_dir.to_path_buf(),
            state: state.clone(),
            watcher: Arc::downgrade(&watcher),
            history,
            on_change,
        };
        std::thread::spawn(move || worker.run(rx));
        Ok(RepoWatcher { state, _watcher: watcher })
    }
}

/// The directories of the working tree that git does not ignore, without the git dir and without
/// submodules. A submodule is a repository of its own; git status reports it as one entry.
fn worktree_dirs(root: &Path) -> Vec<PathBuf> {
    let top = root.to_path_buf();
    ignore::WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .git_exclude(true)
        .filter_entry(move |e| e.file_name() != ".git" && (e.path() == top || !e.path().join(".git").exists()))
        .build()
        .flatten()
        .filter(|e| e.file_type().is_some_and(|t| t.is_dir()))
        .map(|e| e.into_path())
        .collect()
}

struct Worker {
    root: PathBuf,
    git_dir: PathBuf,
    common_dir: PathBuf,
    state: Arc<WatchState>,
    watcher: std::sync::Weak<Mutex<RecommendedWatcher>>,
    history: Option<Arc<LocalHistory>>,
    on_change: Option<OnChange>,
}

impl Worker {
    fn run(self, rx: Receiver<notify::Result<Event>>) {
        let mut paths: Vec<(PathBuf, bool)> = Vec::new();
        loop {
            match rx.recv_timeout(DEBOUNCE) {
                Ok(Ok(ev)) => {
                    if matches!(ev.kind, EventKind::Access(_)) {
                        continue;
                    }
                    let created = matches!(ev.kind, EventKind::Create(_));
                    paths.extend(ev.paths.into_iter().map(|p| (p, created)));
                }
                Ok(Err(_)) => {}
                Err(RecvTimeoutError::Timeout) => {
                    if !paths.is_empty() {
                        self.flush(std::mem::take(&mut paths));
                    }
                    if self.watcher.strong_count() == 0 {
                        return;
                    }
                }
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
    }

    fn flush(&self, paths: Vec<(PathBuf, bool)>) {
        let mut repo = false;
        let mut index = false;
        let mut files: Vec<PathBuf> = Vec::new();
        let mut submodule = false;
        for (p, created) in paths {
            let in_git = [&self.git_dir, &self.common_dir].iter().find_map(|d| p.strip_prefix(d).ok().map(Path::to_path_buf));
            match in_git {
                Some(rel) if rel.as_os_str().is_empty() => {}
                Some(rel) => {
                    let name = rel.to_string_lossy();
                    if name.ends_with(".lock") || name.starts_with("objects") || name.starts_with("rebased-lite") {
                        continue;
                    }
                    if name == "index" {
                        index = true;
                    } else if is_repo_file(&rel) {
                        repo = true;
                    }
                }
                None => {
                    if created && p.is_dir() && cfg!(target_os = "linux") {
                        self.watch_new_dir(&p);
                    }
                    if !p.starts_with(&self.root) || files.contains(&p) {
                        continue;
                    }
                    // A file in a submodule changes the submodule's status only. `git check-ignore`
                    // refuses such a path, and Local History keeps the files of this repository only.
                    if self.in_submodule(&p) {
                        submodule = true;
                    } else {
                        files.push(p);
                    }
                }
            }
        }
        let files = self.not_ignored(files);
        if repo {
            self.state.repo.fetch_add(1, Ordering::SeqCst);
        }
        if index || submodule || !files.is_empty() {
            self.state.files.fetch_add(1, Ordering::SeqCst);
        }
        if repo || index || submodule || !files.is_empty() {
            if let Some(f) = &self.on_change {
                f(self.state.counters());
            }
        }
        if let Some(h) = &self.history {
            if !files.is_empty() && files.len() <= MAX_BULK_FILES {
                h.record(&files, "");
            }
        }
    }

    /// True when a directory between the path and the root has a `.git` entry.
    fn in_submodule(&self, path: &Path) -> bool {
        path.ancestors().skip(1).take_while(|a| *a != self.root && a.starts_with(&self.root)).any(|a| a.join(".git").exists())
    }

    fn watch_new_dir(&self, dir: &Path) {
        let Some(w) = self.watcher.upgrade() else { return };
        let mut w = w.lock().unwrap();
        for d in worktree_dirs(dir) {
            if w.watch(&d, RecursiveMode::NonRecursive).is_err() {
                break;
            }
        }
    }

    /// Drops the paths that git ignores. A tracked file is never ignored.
    fn not_ignored(&self, files: Vec<PathBuf>) -> Vec<PathBuf> {
        if files.is_empty() {
            return files;
        }
        let rel: Vec<String> = files.iter().filter_map(|p| p.strip_prefix(&self.root).ok()).map(|p| p.to_string_lossy().into_owned()).collect();
        let Ok(mut child) = rebased_git::git_command()
            .arg("-C")
            .arg(&self.root)
            .args(["check-ignore", "-z", "--stdin"])
            .env("GIT_OPTIONAL_LOCKS", "0")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        else {
            return files;
        };
        if let Some(mut stdin) = child.stdin.take() {
            use std::io::Write;
            let input: Vec<u8> = rel.iter().flat_map(|r| r.bytes().chain(std::iter::once(0))).collect();
            let _ = stdin.write_all(&input);
        }
        let out = child.wait_with_output().map(|o| o.stdout).unwrap_or_default();
        let ignored: std::collections::HashSet<&[u8]> = out.split(|&b| b == 0).filter(|s| !s.is_empty()).collect();
        files.into_iter().zip(rel.iter()).filter(|(_, r)| !ignored.contains(r.as_bytes())).map(|(p, _)| p).collect()
    }
}
