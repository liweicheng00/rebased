//! Dev server: `rebased-devserver <ui-dist-dir> [port]`. POST /api/<command> runs a command; other paths serve files.
//! It binds to 127.0.0.1 only, because the commands read any repository on disk.
//!
//! Each connection gets its own thread and carries one request. A server with a fixed pool of reader
//! threads can starve: idle connections that a browser opens in advance hold the readers, and new
//! requests wait for them.

use rebased_service::Service;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::time::Duration;

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
    rebased_service::askpass::run_helper_if_requested();
    let args: Vec<String> = std::env::args().collect();
    let dist = Arc::new(std::path::PathBuf::from(args.get(1).cloned().unwrap_or_else(|| "ui/dist".into())));
    let port = args.get(2).cloned().unwrap_or_else(|| "5174".into());
    let listener = TcpListener::bind(format!("127.0.0.1:{port}")).expect("bind");
    eprintln!("rebased-lite dev server on http://127.0.0.1:{port}");
    let exe = std::env::current_exe().expect("current executable");
    let service = Arc::new(Service::with_askpass(&exe));
    // One thread per connection: a push can wait for a password while the page answers the prompt.
    for stream in listener.incoming().flatten() {
        let (service, dist) = (service.clone(), dist.clone());
        std::thread::spawn(move || {
            let _ = handle(stream, &service, &dist);
        });
    }
}

struct Request {
    method: String,
    url: String,
    body: Vec<u8>,
}

/// Reads one HTTP/1.1 request. None when the connection closes before a full request.
fn read_request(stream: &TcpStream) -> std::io::Result<Option<Request>> {
    // A connection that the browser opened in advance and never uses must not keep a thread forever.
    stream.set_read_timeout(Some(Duration::from_secs(60)))?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Ok(None);
    }
    let mut parts = line.split_whitespace();
    let (Some(method), Some(url)) = (parts.next(), parts.next()) else { return Ok(None) };
    let (method, url) = (method.to_string(), url.to_string());
    let mut length = 0usize;
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h)? == 0 {
            return Ok(None);
        }
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            if k.trim().eq_ignore_ascii_case("content-length") {
                length = v.trim().parse().unwrap_or(0);
            }
        }
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    Ok(Some(Request { method, url, body }))
}

fn respond(mut stream: &TcpStream, status: u16, content_type: &str, body: &[u8]) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "Error",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}

fn handle(stream: TcpStream, service: &Service, dist: &std::path::Path) -> std::io::Result<()> {
    let Some(req) = read_request(&stream)? else { return Ok(()) };
    let url = req.url.split('?').next().unwrap_or("/").to_string();
    if url == "/events" {
        return events(stream, service);
    }
    if let Some(cmd) = url.strip_prefix("/api/") {
        if req.method != "POST" {
            return respond(&stream, 400, "application/json", serde_json_string("use POST").as_bytes());
        }
        let body = String::from_utf8_lossy(&req.body);
        let log = std::env::var_os("REBASED_DEV_LOG").is_some();
        let t = std::time::Instant::now();
        if log {
            eprintln!("start {cmd}");
        }
        let (status, text) = match service.dispatch(cmd, &body) {
            Ok(json) => (200, json),
            Err(e) => (400, rebased_service::errors::error_json(&e).to_string()),
        };
        if log {
            eprintln!("end   {cmd} {status} {} ms", t.elapsed().as_millis());
        }
        return respond(&stream, status, "application/json", text.as_bytes());
    }
    let rel = if url == "/" { "index.html".to_string() } else { url.trim_start_matches('/').to_string() };
    if rel.split('/').any(|p| p == "..") {
        return respond(&stream, 400, "text/plain", b"");
    }
    match std::fs::read(dist.join(&rel)) {
        Ok(bytes) => respond(&stream, 200, content_type(&rel), &bytes),
        Err(_) => respond(&stream, 404, "text/plain", b""),
    }
}

/// Server-sent events: the backend events, one JSON object each. A comment line every 15 s finds a
/// closed connection, so its thread ends.
fn events(mut stream: TcpStream, service: &Service) -> std::io::Result<()> {
    let rx = service.subscribe();
    stream.set_read_timeout(None)?;
    stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: keep-alive\r\n\r\n: open\n\n")?;
    loop {
        match rx.recv_timeout(Duration::from_secs(15)) {
            Ok(e) => {
                let json = serde_json::to_string(&e).unwrap_or_default();
                stream.write_all(format!("data: {json}\n\n").as_bytes())?;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => stream.write_all(b": ping\n\n")?,
            Err(_) => return Ok(()),
        }
        stream.flush()?;
    }
}

fn serde_json_string(s: &str) -> String {
    serde_json::json!({ "error": s }).to_string()
}
