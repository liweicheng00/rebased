//! The open repositories, one per tab.

use crate::view::{build_full, build_view, View};
use crate::{askpass, config, err, history, watch, OpenArgs, PathArgs, Result, Service, ViewArgs, ViewResult};
use rebased_git::{CommitDetails, Repo, Topology};
use rebased_graph::linear::PermanentLinearGraph;
use std::collections::HashMap;
use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub(crate) struct Session {
    pub(crate) repo: Repo,
    pub(crate) topo: Topology,
    pub(crate) full: PermanentLinearGraph,
    pub(crate) settings: ViewArgs,
    pub(crate) view: View,
    pub(crate) details: HashMap<usize, CommitDetails>,
    pub(crate) head_node: Option<usize>,
    /// None when the watcher could not start; the front end then refreshes on focus only.
    pub(crate) watcher: Option<watch::RepoWatcher>,
    pub(crate) history: Arc<history::LocalHistory>,
}

/// The open repositories, one per tab, and the one that the commands use when a command names no
/// repository. The map lock is held only to find a session; each session has its own lock, so a slow
/// command in one repository does not stop the commands of another.
#[derive(Default)]
pub(crate) struct Sessions {
    pub(crate) map: HashMap<PathBuf, Arc<Mutex<Session>>>,
    pub(crate) active: Option<PathBuf>,
}

thread_local! {
    /// The repository of the command that this thread runs; see [`Service::scoped`].
    static SCOPE: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
}

impl Service {
    /// A service whose git commands ask for credentials through `helper`, the executable of the app. The
    /// executable must call [`askpass::run_helper_if_requested`] first in `main`.
    pub fn with_askpass(helper: &Path) -> Service {
        let config_dir = config::config_dir();
        let settings = config::load(&config_dir);
        // A git program that does not work any more falls back to git from PATH.
        let _ = rebased_git::set_git_program(&settings.git_path);
        Service { askpass: askpass::Askpass::start(helper).ok(), config_dir, settings: Mutex::new(settings), ..Service::default() }
    }

    pub fn askpass_pending(&self) -> Vec<askpass::Prompt> {
        self.askpass.as_ref().map(|a| a.pending()).unwrap_or_default()
    }

    pub fn askpass_answer(&self, a: askpass::Answer) {
        if let Some(p) = &self.askpass {
            p.answer(a);
        }
    }

    pub fn open(&self, args: OpenArgs) -> Result<ViewResult> {
        let repo = Repo::open(Path::new(&args.path)).map_err(err)?;
        self.load(repo, args.view, false)
    }

    /// The version of a git program, for the Test button of the settings. It changes nothing.
    pub fn git_version(&self, args: PathArgs) -> Result<String> {
        rebased_git::git_version(&args.path).map_err(err)
    }

    pub fn backend_settings(&self) -> Result<config::BackendSettings> {
        Ok(self.settings.lock().unwrap().clone())
    }

    /// Applies and saves the settings. A git program that is not git is refused and nothing changes.
    /// Returns the version of the git program.
    pub fn set_backend_settings(&self, mut s: config::BackendSettings) -> Result<String> {
        let version = rebased_git::set_git_program(&s.git_path).map_err(err)?;
        let sessions: Vec<_> = self.session.lock().unwrap().map.values().cloned().collect();
        for session in sessions {
            session.lock().unwrap().history.set_limits(s.history);
        }
        s.stored = true;
        config::save(&self.config_dir, &s)?;
        *self.settings.lock().unwrap() = s;
        Ok(version)
    }

    /// Makes an open repository the active one, for a tab switch. A repository that is not open yet is
    /// opened.
    pub fn activate(&self, args: OpenArgs) -> Result<ViewResult> {
        let repo = Repo::open(Path::new(&args.path)).map_err(err)?;
        let open = self.session.lock().unwrap().map.get(&repo.root).cloned();
        if let Some(s) = open {
            let result = Self::result(&mut s.lock().unwrap(), std::time::Instant::now());
            self.session.lock().unwrap().active = Some(repo.root);
            return Ok(result);
        }
        self.load(repo, args.view, false)
    }

    /// Closes the tab of a repository: its watcher stops and its memory is freed.
    pub fn close(&self, args: PathArgs) -> Result<()> {
        let root = Repo::open(Path::new(&args.path)).map(|r| r.root).unwrap_or_else(|_| args.path.into());
        let mut sessions = self.session.lock().unwrap();
        sessions.map.remove(&root);
        if sessions.active.as_ref() == Some(&root) {
            sessions.active = None;
        }
        Ok(())
    }

    /// Loads the repository. A refresh (`keep`) keeps the watcher and Local History of the same
    /// repository. An open starts them again, because the directory can be new at the same path.
    /// The graph builds without a lock; the old session answers commands until the new one replaces it.
    pub(crate) fn load(&self, repo: Repo, settings: ViewArgs, keep: bool) -> Result<ViewResult> {
        let t = std::time::Instant::now();
        let topo = repo.load_topology().map_err(err)?;
        let full = build_full(&topo);
        let view = build_view(&repo, &topo, &full, &settings)?;
        let head_node = repo.resolve("HEAD").and_then(|o| topo.node_of(&o));
        let old = self.session.lock().unwrap().map.get(&repo.root).cloned();
        let (kept, history) = match old {
            Some(o) if keep => {
                let mut o = o.lock().unwrap();
                (o.watcher.take(), Some(o.history.clone()))
            }
            _ => (None, None),
        };
        let history = history
            .unwrap_or_else(|| Arc::new(history::LocalHistory::open(&repo.root, &repo.git_dir(), self.settings.lock().unwrap().history)));
        let watcher =
            kept.or_else(|| watch::RepoWatcher::start(&repo.root, &repo.git_dir(), &repo.common_dir(), Some(history.clone())).ok());
        let mut s = Session { repo, topo, full, settings, view, details: HashMap::new(), head_node, watcher, history };
        let result = Self::result(&mut s, t);
        let root = s.repo.root.clone();
        let mut sessions = self.session.lock().unwrap();
        // A refresh of a tab that is not active any more must not change the active tab.
        if !keep {
            sessions.active = Some(root.clone());
        }
        sessions.map.insert(root, Arc::new(Mutex::new(s)));
        Ok(result)
    }

    pub(crate) fn result(s: &mut Session, t: std::time::Instant) -> ViewResult {
        let head_oid = s.head_node.map(|n| s.topo.oid_hex(n));
        ViewResult {
            root: s.repo.root.display().to_string(),
            head: s.topo.head.clone(),
            head_oid,
            total_commits: s.topo.oids.len(),
            row_count: s.view.graph.row_count(),
            filtered: s.view.nodes.is_some(),
            collapsed: s.view.graph.has_collapsed(),
            recommended_width: s.view.printer.recommended_width(),
            load_ms: t.elapsed().as_millis(),
        }
    }

    /// Runs `f` with the repository of the command: the scoped one, else the active one.
    pub(crate) fn scoped<T>(&self, root: Option<PathBuf>, f: impl FnOnce() -> T) -> T {
        struct Reset;
        impl Drop for Reset {
            fn drop(&mut self) {
                SCOPE.with(|s| *s.borrow_mut() = None);
            }
        }
        SCOPE.with(|s| *s.borrow_mut() = root);
        let _reset = Reset;
        f()
    }

    /// The session of the command: the repository that the command names, else the active one.
    fn current(&self) -> Result<Arc<Mutex<Session>>> {
        let scoped = SCOPE.with(|s| s.borrow().clone());
        let sessions = self.session.lock().unwrap();
        let root = scoped.as_ref().or(sessions.active.as_ref()).ok_or("no repository is open")?;
        sessions.map.get(root).cloned().ok_or_else(|| format!("{} is not open", root.display()))
    }

    /// Runs `f` with the session locked. Use it for the graph and the view, which the session owns.
    pub(crate) fn with<T>(&self, f: impl FnOnce(&mut Session) -> Result<T>) -> Result<T> {
        let s = self.current()?;
        let mut s = s.lock().unwrap();
        f(&mut s)
    }

    /// Runs `f` with the repository and no lock held. Use it for git commands, which can be slow.
    pub(crate) fn with_repo<T>(&self, f: impl FnOnce(&Repo) -> Result<T>) -> Result<T> {
        let repo = self.with(|s| Ok(s.repo.clone()))?;
        f(&repo)
    }

    /// Reloads commits and refs from disk and keeps the current view settings.
    pub fn refresh(&self) -> Result<ViewResult> {
        let root = self.with(|s| Ok(s.repo.root.clone()))?;
        self.refresh_at(&root)
    }

    /// Reloads one repository, whichever tab is active.
    pub(crate) fn refresh_at(&self, root: &Path) -> Result<ViewResult> {
        let s = self.session.lock().unwrap().map.get(root).cloned().ok_or_else(|| format!("{} is not open", root.display()))?;
        let settings = s.lock().unwrap().settings.clone();
        self.load(Repo::open(root).map_err(err)?, settings, true)
    }

    pub fn fetch(&self) -> Result<ViewResult> {
        self.with_repo(|r| r.fetch().map(|_| ()).map_err(err))?;
        self.refresh()
    }
}
