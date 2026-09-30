//! The open repositories, one per tab.

use crate::view::{build_full, build_view, View};
use crate::{askpass, err, history, watch, OpenArgs, PathArgs, Result, Service, ViewArgs, ViewResult};
use rebased_git::{CommitDetails, Repo, Topology};
use rebased_graph::linear::PermanentLinearGraph;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

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

/// The open repositories, one per tab, and the one that the commands use.
#[derive(Default)]
pub(crate) struct Sessions {
    pub(crate) map: HashMap<std::path::PathBuf, Session>,
    pub(crate) active: Option<std::path::PathBuf>,
}

impl Sessions {
    pub(crate) fn active_mut(&mut self) -> Option<&mut Session> {
        let root = self.active.as_ref()?;
        self.map.get_mut(root)
    }
}

impl Service {
    /// A service whose git commands ask for credentials through `helper`, the executable of the app. The
    /// executable must call [`askpass::run_helper_if_requested`] first in `main`.
    pub fn with_askpass(helper: &Path) -> Service {
        Service { askpass: askpass::Askpass::start(helper).ok(), ..Service::default() }
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

    /// Sets the git program for all repositories and returns its version. Empty means `git` from PATH.
    pub fn set_git_program(&self, args: PathArgs) -> Result<String> {
        rebased_git::set_git_program(&args.path).map_err(err)
    }

    /// Makes an open repository the active one, for a tab switch. A repository that is not open yet is
    /// opened.
    pub fn activate(&self, args: OpenArgs) -> Result<ViewResult> {
        let repo = Repo::open(Path::new(&args.path)).map_err(err)?;
        {
            let mut sessions = self.session.lock().unwrap();
            if let Some(s) = sessions.map.get_mut(&repo.root) {
                let result = Self::result(s, std::time::Instant::now());
                sessions.active = Some(repo.root);
                return Ok(result);
            }
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
    pub(crate) fn load(&self, repo: Repo, settings: ViewArgs, keep: bool) -> Result<ViewResult> {
        let t = std::time::Instant::now();
        let topo = repo.load_topology().map_err(err)?;
        let full = build_full(&topo);
        let view = build_view(&repo, &topo, &full, &settings)?;
        let head_node = repo.resolve("HEAD").and_then(|o| topo.node_of(&o));
        // The old session stays until the new one replaces it, so concurrent commands never see
        // "no repository".
        let (kept, history) = match self.session.lock().unwrap().map.get_mut(&repo.root) {
            Some(o) if keep => (o.watcher.take(), Some(o.history.clone())),
            _ => (None, None),
        };
        let history = history
            .unwrap_or_else(|| Arc::new(history::LocalHistory::open(&repo.root, &repo.git_dir(), *self.history_limits.lock().unwrap())));
        let watcher =
            kept.or_else(|| watch::RepoWatcher::start(&repo.root, &repo.git_dir(), &repo.common_dir(), Some(history.clone())).ok());
        let mut s = Session { repo, topo, full, settings, view, details: HashMap::new(), head_node, watcher, history };
        let result = Self::result(&mut s, t);
        let mut sessions = self.session.lock().unwrap();
        // A refresh of a tab that is not active any more must not change the active tab.
        if !keep {
            sessions.active = Some(s.repo.root.clone());
        }
        sessions.map.insert(s.repo.root.clone(), s);
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

    pub(crate) fn with<T>(&self, f: impl FnOnce(&mut Session) -> Result<T>) -> Result<T> {
        let mut guard = self.session.lock().unwrap();
        let s = guard.active_mut().ok_or("no repository is open")?;
        f(s)
    }

    /// Reloads commits and refs from disk and keeps the current view settings.
    pub fn refresh(&self) -> Result<ViewResult> {
        let (root, settings) = self.with(|s| Ok((s.repo.root.clone(), s.settings.clone())))?;
        self.load(Repo::open(&root).map_err(err)?, settings, true)
    }

    pub fn fetch(&self) -> Result<ViewResult> {
        let root = self.with(|s| Ok(s.repo.root.clone()))?;
        Repo::open(&root).map_err(err)?.fetch().map_err(err)?;
        self.refresh()
    }
}
