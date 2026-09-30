// Hides the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rebased_service::Service;
use serde_json::Value;
use tauri::{Emitter, Manager, State};

/// Runs a command of the service by name, as the dev server does. The command runs off the UI thread,
/// because git can take a while on a large repository. `body` holds the arguments, and "root" names the
/// repository of the command.
#[tauri::command(async)]
fn call(state: State<'_, Service>, cmd: String, body: Value) -> Result<Value, String> {
    let out = state.dispatch(&cmd, &body.to_string())?;
    serde_json::from_str(&out).map_err(|e| e.to_string())
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
    rebased_service::askpass::run_helper_if_requested();
    #[cfg(target_os = "linux")]
    use_software_rendering_without_gpu();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Service::with_askpass(&std::env::current_exe().expect("current executable")))
        .setup(|app| {
            // The backend events go to the window as "backend-event".
            let events = app.state::<Service>().subscribe();
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                for e in events {
                    let _ = handle.emit("backend-event", e);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![initial_path, call])
        .run(tauri::generate_context!())
        .expect("error while running Rebased Lite");
}
