//! The commands by name, for the dev server and the Tauri app.

use crate::{err, Result, Service};
use serde::Deserialize;

impl Service {
    /// Dispatches a command by name; used by the dev server.
    pub fn dispatch(&self, cmd: &str, body: &str) -> Result<String> {
        // A command can name its repository with "root"; without it, the command uses the active tab.
        // Then a command that a tab sent before a tab switch still reads its own repository.
        let mut value: serde_json::Value = serde_json::from_str(if body.trim().is_empty() { "{}" } else { body }).map_err(err)?;
        let root = value.as_object_mut().and_then(|o| o.remove("root")).and_then(|r| r.as_str().map(std::path::PathBuf::from));
        let body = value.to_string();
        self.scoped(root, || self.dispatch_scoped(cmd, &body))
    }

    fn dispatch_scoped(&self, cmd: &str, body: &str) -> Result<String> {
        fn parse<T: for<'de> Deserialize<'de>>(b: &str) -> Result<T> {
            serde_json::from_str(if b.trim().is_empty() { "{}" } else { b }).map_err(err)
        }
        let out = match cmd {
            "open" => serde_json::to_string(&self.open(parse(body)?)?),
            "set_view" => serde_json::to_string(&self.set_view(parse(body)?)?),
            "refresh" => serde_json::to_string(&self.refresh()?),
            "set_git_program" => serde_json::to_string(&self.set_git_program(parse(body)?)?),
            "activate" => serde_json::to_string(&self.activate(parse(body)?)?),
            "close" => serde_json::to_string(&self.close(parse(body)?)?),
            "fetch" => serde_json::to_string(&self.fetch()?),
            "refs" => serde_json::to_string(&self.refs()?),
            "rows" => serde_json::to_string(&self.rows(parse(body)?)?),
            "commit" => serde_json::to_string(&self.commit(parse(body)?)?),
            "find" => serde_json::to_string(&self.find(parse(body)?)?),
            "collapse" => serde_json::to_string(&self.collapse(parse(body)?)?),
            "local_changes" => serde_json::to_string(&self.local_changes()?),
            "changelist_op" => serde_json::to_string(&self.changelist_op(parse(body)?)?),
            "push_info" => serde_json::to_string(&self.push_info(parse(body)?)?),
            "stashes" => serde_json::to_string(&self.stashes()?),
            "stash_detail" => serde_json::to_string(&self.stash_detail(parse(body)?)?),
            "merge_sides" => serde_json::to_string(&self.merge_sides(parse(body)?)?),
            "file_history" => serde_json::to_string(&self.file_history(parse(body)?)?),
            "blame" => serde_json::to_string(&self.blame(parse(body)?)?),
            "watch_state" => serde_json::to_string(&self.watch_state()?),
            "askpass_pending" => serde_json::to_string(&self.askpass_pending()),
            "askpass_answer" => {
                self.askpass_answer(parse(body)?);
                Ok("null".to_string())
            }
            "head_message" => serde_json::to_string(&self.head_message()?),
            "submodules" => serde_json::to_string(&self.submodules()?),
            "remotes" => serde_json::to_string(&self.remotes()?),
            "commit_template" => serde_json::to_string(&self.commit_template()?),
            "local_history" => serde_json::to_string(&self.local_history(parse(body)?)?),
            "local_history_content" => serde_json::to_string(&self.local_history_content(parse(body)?)?),
            "set_local_history_limits" => serde_json::to_string(&self.set_local_history_limits(parse(body)?)?),
            "repo_state" => serde_json::to_string(&self.state()?),
            "worktrees" => serde_json::to_string(&self.worktrees()?),
            "recent_branches" => serde_json::to_string(&self.recent_branches()?),
            "rewrite_range" => serde_json::to_string(&self.rewrite_range(parse(body)?)?),
            "run_op" => serde_json::to_string(&self.run_op(parse(body)?)?),
            "compare" => serde_json::to_string(&self.compare(parse(body)?)?),
            "compare_refs" => serde_json::to_string(&self.compare_refs(parse(body)?)?),
            "file_pair" => serde_json::to_string(&self.file_pair(parse(body)?)?),
            _ => return Err(format!("unknown command {cmd}")),
        };
        out.map_err(err)
    }
}
