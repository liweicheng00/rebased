// Hides the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rebased_service::{CollapseArgs, CompareArgs, FilePairArgs, FindArgs, OidArgs, Op, OpenArgs, RowsArgs, Service, ViewArgs};
use serde_json::Value;
use tauri::State;

// Each command runs off the UI thread; git calls can take a while on large repositories.
fn json<T: serde::Serialize>(r: Result<T, String>) -> Result<Value, String> {
    r.and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

#[tauri::command(async)]
fn open(state: State<'_, Service>, args: OpenArgs) -> Result<Value, String> {
    json(state.open(args))
}

#[tauri::command(async)]
fn rows(state: State<'_, Service>, args: RowsArgs) -> Result<Value, String> {
    json(state.rows(args))
}

#[tauri::command(async)]
fn set_view(state: State<'_, Service>, args: ViewArgs) -> Result<Value, String> {
    json(state.set_view(args))
}

#[tauri::command(async)]
fn refresh(state: State<'_, Service>) -> Result<Value, String> {
    json(state.refresh())
}

#[tauri::command(async)]
fn fetch(state: State<'_, Service>) -> Result<Value, String> {
    json(state.fetch())
}

#[tauri::command(async)]
fn refs(state: State<'_, Service>) -> Result<Value, String> {
    json(state.refs())
}

#[tauri::command(async)]
fn commit(state: State<'_, Service>, args: OidArgs) -> Result<Value, String> {
    json(state.commit(args))
}

#[tauri::command(async)]
fn find(state: State<'_, Service>, args: FindArgs) -> Result<Value, String> {
    json(state.find(args))
}

#[tauri::command(async)]
fn compare(state: State<'_, Service>, args: CompareArgs) -> Result<Value, String> {
    json(state.compare(args))
}

#[tauri::command(async)]
fn file_pair(state: State<'_, Service>, args: FilePairArgs) -> Result<Value, String> {
    json(state.file_pair(args))
}

#[tauri::command(async)]
fn collapse(state: State<'_, Service>, args: CollapseArgs) -> Result<Value, String> {
    json(state.collapse(args))
}

#[tauri::command(async)]
fn worktrees(state: State<'_, Service>) -> Result<Value, String> {
    json(state.worktrees())
}

#[tauri::command(async)]
fn recent_branches(state: State<'_, Service>) -> Result<Value, String> {
    json(state.recent_branches())
}

#[tauri::command(async)]
fn local_changes(state: State<'_, Service>) -> Result<Value, String> {
    json(state.local_changes())
}

#[tauri::command(async)]
fn changelist_op(state: State<'_, Service>, args: rebased_service::ChangeListOp) -> Result<Value, String> {
    json(state.changelist_op(args))
}

#[tauri::command(async)]
fn push_info(state: State<'_, Service>, args: rebased_service::PushInfoArgs) -> Result<Value, String> {
    json(state.push_info(args))
}

#[tauri::command(async)]
fn stashes(state: State<'_, Service>) -> Result<Value, String> {
    json(state.stashes())
}

#[tauri::command(async)]
fn stash_detail(state: State<'_, Service>, args: rebased_service::IndexArgs) -> Result<Value, String> {
    json(state.stash_detail(args))
}

#[tauri::command(async)]
fn merge_sides(state: State<'_, Service>, args: rebased_service::PathArgs) -> Result<Value, String> {
    json(state.merge_sides(args))
}

#[tauri::command(async)]
fn file_history(state: State<'_, Service>, args: rebased_service::PathArgs) -> Result<Value, String> {
    json(state.file_history(args))
}

#[tauri::command(async)]
fn blame(state: State<'_, Service>, args: rebased_service::BlameArgs) -> Result<Value, String> {
    json(state.blame(args))
}

#[tauri::command(async)]
fn watch_state(state: State<'_, Service>) -> Result<Value, String> {
    json(state.watch_state())
}

#[tauri::command(async)]
fn head_message(state: State<'_, Service>) -> Result<Value, String> {
    json(state.head_message())
}

#[tauri::command(async)]
fn repo_state(state: State<'_, Service>) -> Result<Value, String> {
    json(state.state())
}

#[tauri::command(async)]
fn rewrite_range(state: State<'_, Service>, args: OidArgs) -> Result<Value, String> {
    json(state.rewrite_range(args))
}

#[tauri::command(async)]
fn run_op(state: State<'_, Service>, args: Op) -> Result<Value, String> {
    json(state.run_op(args))
}

/// The repository path given on the command line, if any.
#[tauri::command]
fn initial_path() -> Option<String> {
    std::env::args().nth(1).filter(|a| !a.starts_with('-'))
}

/// WebKitGTK draws with OpenGL. Without a GPU render node, Mesa runs OpenGL on the CPU (llvmpipe), and the
/// GL buffers live in normal memory: about 280 MB more on git/git, and more CPU time. The software path of
/// WebKit is cheaper then. A user setting of the variable wins.
#[cfg(target_os = "linux")]
fn use_software_rendering_without_gpu() {
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_some() {
        return;
    }
    let has_gpu = std::fs::read_dir("/dev/dri")
        .map(|d| d.flatten().any(|e| e.file_name().to_string_lossy().starts_with("renderD")))
        .unwrap_or(false);
    if !has_gpu {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

fn main() {
    #[cfg(target_os = "linux")]
    use_software_rendering_without_gpu();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Service::default())
        .invoke_handler(tauri::generate_handler![initial_path, open, set_view, refresh, fetch, refs, rows, commit, find, compare, file_pair, collapse, repo_state, rewrite_range, run_op, worktrees, recent_branches, local_changes, changelist_op, head_message, push_info, stashes, stash_detail, merge_sides, file_history, blame, watch_state])
        .run(tauri::generate_context!())
        .expect("error while running Rebased Lite");
}
