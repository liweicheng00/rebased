//! open_url opens web pages only: a remote URL must never start a program or open a file.

use rebased_service::Service;

#[test]
fn only_web_addresses_open() {
    let s = Service::with_askpass(&std::env::current_exe().unwrap());
    for bad in ["file:///etc/passwd", "javascript:alert(1)", "/Applications/Calculator.app", "https://a.b/ x", "ssh://git@host/x", "https://a.b/\n-x"] {
        let r = s.open_url(serde_json::from_value(serde_json::json!({ "url": bad })).unwrap());
        assert!(r.is_err_and(|e| e.contains("not a web address")), "{bad}");
    }
}
