// Hides the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rebased_service::{CompareArgs, FilePairArgs, FindArgs, OidArgs, OpenArgs, RowsArgs, Service, ViewArgs};
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

/// The repository path given on the command line, if any.
#[tauri::command]
fn initial_path() -> Option<String> {
    std::env::args().nth(1).filter(|a| !a.starts_with('-'))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Service::default())
        .invoke_handler(tauri::generate_handler![initial_path, open, set_view, refresh, fetch, refs, rows, commit, find, compare, file_pair])
        .run(tauri::generate_context!())
        .expect("error while running Rebased Lite");
}
