//! Dev server: `rebased-devserver <ui-dist-dir> [port]`. POST /api/<command> runs a command; other paths serve files.
//! It binds to 127.0.0.1 only, because the commands read any repository on disk.

use rebased_service::Service;
use tiny_http::{Header, Response, Server};

fn content_type(path: &str) -> &'static str {
    match path.rsplit('.').next() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript",
        Some("css") => "text/css",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("wasm") => "application/wasm",
        Some("ttf") => "font/ttf",
        _ => "application/octet-stream",
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dist = std::path::PathBuf::from(args.get(1).cloned().unwrap_or_else(|| "ui/dist".into()));
    let port = args.get(2).cloned().unwrap_or_else(|| "5174".into());
    let server = Server::http(format!("127.0.0.1:{port}")).expect("bind");
    eprintln!("rebased-lite dev server on http://127.0.0.1:{port}");
    let service = Service::default();
    for mut req in server.incoming_requests() {
        let url = req.url().split('?').next().unwrap_or("/").to_string();
        if let Some(cmd) = url.strip_prefix("/api/") {
            let mut body = String::new();
            let _ = req.as_reader().read_to_string(&mut body);
            let (status, text) = match service.dispatch(cmd, &body) {
                Ok(json) => (200, json),
                Err(e) => (400, serde_json_string(&e)),
            };
            let header = Header::from_bytes("Content-Type", "application/json").unwrap();
            let _ = req.respond(Response::from_string(text).with_status_code(status).with_header(header));
            continue;
        }
        let rel = if url == "/" { "index.html".to_string() } else { url.trim_start_matches('/').to_string() };
        if rel.split('/').any(|p| p == "..") {
            let _ = req.respond(Response::empty(400));
            continue;
        }
        match std::fs::read(dist.join(&rel)) {
            Ok(bytes) => {
                let header = Header::from_bytes("Content-Type", content_type(&rel)).unwrap();
                let _ = req.respond(Response::from_data(bytes).with_header(header));
            }
            Err(_) => {
                let _ = req.respond(Response::empty(404));
            }
        }
    }
}

fn serde_json_string(s: &str) -> String {
    serde_json::json!({ "error": s }).to_string()
}
