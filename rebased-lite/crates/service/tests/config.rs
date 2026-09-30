//! The backend settings file: it is read at start, written on change, and a bad git program is refused.

use rebased_service::config::BackendSettings;
use rebased_service::history::Limits;
use rebased_service::Service;

#[test]
fn settings_file() {
    let dir = std::env::temp_dir().join(format!("rebased-lite-config-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::env::set_var("REBASED_LITE_CONFIG_DIR", &dir);
    let exe = std::env::current_exe().unwrap();

    // No file yet: the defaults, not stored.
    let s = Service::with_askpass(&exe);
    let first = s.backend_settings().unwrap();
    assert!(!first.stored);
    assert_eq!(first.history, Limits::default());

    // A program that is not git is refused, and nothing is written.
    let bad = BackendSettings { git_path: "/bin/true".into(), ..first.clone() };
    assert!(s.set_backend_settings(bad).is_err());
    assert!(!dir.join("settings.json").exists());

    // Good settings are applied and written.
    let good = BackendSettings { git_path: String::new(), history: Limits { days: 9, max_mb: 50 }, stored: false };
    let version = s.set_backend_settings(good).unwrap();
    assert!(version.chars().next().unwrap().is_ascii_digit());
    assert!(dir.join("settings.json").exists());

    // A new service, as after a restart, reads them.
    let t = Service::with_askpass(&exe);
    let read = t.backend_settings().unwrap();
    assert!(read.stored);
    assert_eq!(read.history, Limits { days: 9, max_mb: 50 });
    assert_eq!(s.git_version(rebased_service::PathArgs { path: String::new() }).unwrap(), version);
}
