//! The UI's HTTP/1.1 (UI-3): `GET`/`POST`, `Connection: close`, bounded requests, a few
//! worker threads. No crate: two methods and no chunked bodies.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError, sync_channel};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// Connections being served, so `stop` can shut them down.
type Live = Arc<Mutex<Vec<(u64, TcpStream)>>>;

/// Request line + headers.
pub const MAX_HEAD: usize = 8 << 10;
/// A `POST` body.
pub const MAX_BODY: usize = 4 << 10;
pub const WORKERS: usize = 4;
pub const QUEUE: usize = 16;

#[derive(Debug, Clone)]
pub struct Request {
    pub method: String,
    pub path: String,
    /// Lowercased names.
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }
}

#[derive(Debug, Clone)]
pub struct Response {
    pub status: u16,
    pub content_type: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn new(status: u16, content_type: &str, body: impl Into<Vec<u8>>) -> Response {
        Response {
            status,
            content_type: content_type.into(),
            headers: Vec::new(),
            body: body.into(),
        }
    }

    pub fn text(status: u16, body: &str) -> Response {
        Response::new(status, "text/plain; charset=utf-8", body)
    }

    pub fn json(v: &serde_json::Value) -> Response {
        Response::new(200, "application/json", v.to_string())
    }

    pub fn with(mut self, name: &str, value: &str) -> Response {
        self.headers.push((name.into(), value.into()));
        self
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        411 => "Length Required",
        413 => "Payload Too Large",
        421 => "Misdirected Request",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        _ => "Status",
    }
}

/// Every response's headers (UI-4), then the handler's own.
pub fn write(stream: &mut TcpStream, r: &Response) -> std::io::Result<()> {
    let mut head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\
         Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n\
         Referrer-Policy: no-referrer\r\nX-Frame-Options: DENY\r\n",
        r.status,
        reason(r.status),
        r.content_type,
        r.body.len()
    );
    for (k, v) in &r.headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;
    stream.write_all(&r.body)?;
    stream.flush()
}

/// Reads one request within `deadline`; `Err` = the response to send instead.
pub fn read(stream: &TcpStream, deadline: Instant) -> Result<Request, Response> {
    let mut reader = BufReader::new(stream.try_clone().map_err(|_| Response::text(500, "io"))?);
    let mut head = Vec::new();
    loop {
        if Instant::now() > deadline {
            return Err(Response::text(400, "request timed out"));
        }
        let mut line = Vec::new();
        let n = reader
            .by_ref()
            .take((MAX_HEAD + 1 - head.len().min(MAX_HEAD)) as u64)
            .read_until(b'\n', &mut line)
            .map_err(|_| Response::text(400, "bad request"))?;
        if n == 0 {
            return Err(Response::text(400, "bad request"));
        }
        head.extend_from_slice(&line);
        if head.len() > MAX_HEAD {
            return Err(Response::text(431, "headers too large"));
        }
        if line == b"\r\n" || line == b"\n" {
            break;
        }
    }
    let head = String::from_utf8(head).map_err(|_| Response::text(400, "bad request"))?;
    let mut lines = head.lines();
    let mut first = lines.next().unwrap_or_default().split(' ');
    let (method, path) = match (first.next(), first.next()) {
        (Some(m), Some(p)) => (m.to_string(), p.to_string()),
        _ => return Err(Response::text(400, "bad request")),
    };
    let mut headers = HashMap::new();
    for l in lines {
        if let Some((k, v)) = l.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }
    if method != "GET" && method != "POST" {
        return Err(Response::text(405, "GET or POST"));
    }
    if headers.contains_key("transfer-encoding") {
        return Err(Response::text(411, "Content-Length only"));
    }
    let len = match headers.get("content-length") {
        None => 0,
        Some(v) => v
            .parse::<usize>()
            .map_err(|_| Response::text(400, "bad Content-Length"))?,
    };
    if len > MAX_BODY {
        return Err(Response::text(413, "body too large"));
    }
    let mut body = vec![0; len];
    reader
        .read_exact(&mut body)
        .map_err(|_| Response::text(400, "short body"))?;
    Ok(Request {
        method,
        path,
        headers,
        body,
    })
}

/// The handler a server runs per request.
pub type Handler = Arc<dyn Fn(&Request) -> Response + Send + Sync>;

/// A running server: `stop` closes it and joins every thread.
pub struct Server {
    pub port: u16,
    stop: Arc<AtomicBool>,
    threads: Vec<JoinHandle<()>>,
    live: Live,
}

impl Server {
    /// Binds `127.0.0.1:<port>` (never another address; 0 = any free port, for tests) and
    /// serves `handler` on [`WORKERS`] threads, `timeout` per request.
    pub fn start(port: u16, handler: Handler, timeout: Duration) -> Result<Server, String> {
        let listener =
            TcpListener::bind(("127.0.0.1", port)).map_err(|e| format!("127.0.0.1:{port}: {e}"))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let stop = Arc::new(AtomicBool::new(false));
        let live: Live = Arc::new(Mutex::new(Vec::new()));
        let ids = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let (tx, rx): (SyncSender<TcpStream>, Receiver<TcpStream>) = sync_channel(QUEUE);
        let rx = Arc::new(Mutex::new(rx));
        let mut threads = Vec::new();
        for _ in 0..WORKERS {
            let (rx, handler, live, stop, ids) = (
                rx.clone(),
                handler.clone(),
                live.clone(),
                stop.clone(),
                ids.clone(),
            );
            threads.push(std::thread::spawn(move || {
                loop {
                    let next = rx
                        .lock()
                        .map(|r| r.recv_timeout(Duration::from_millis(200)));
                    match next {
                        Ok(Ok(s)) => {
                            let id = ids.fetch_add(1, Ordering::SeqCst);
                            serve_one(s, id, &handler, timeout, &live)
                        }
                        Ok(Err(_)) if stop.load(Ordering::SeqCst) => return,
                        Ok(Err(_)) => {}
                        Err(_) => return,
                    }
                }
            }));
        }
        let accept_stop = stop.clone();
        threads.push(std::thread::spawn(move || {
            while !accept_stop.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((s, _)) => {
                        let _ = s.set_nonblocking(false);
                        // Full queue: the connection is dropped (UI-3).
                        if let Err(TrySendError::Disconnected(_)) = tx.try_send(s) {
                            return;
                        }
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(50)),
                }
            }
        }));
        Ok(Server {
            port,
            stop,
            threads,
            live,
        })
    }

    pub fn stop(self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Ok(live) = self.live.lock() {
            for (_, s) in live.iter() {
                let _ = s.shutdown(Shutdown::Both);
            }
        }
        for t in self.threads {
            let _ = t.join();
        }
    }
}

fn serve_one(mut s: TcpStream, id: u64, handler: &Handler, timeout: Duration, live: &Live) {
    let io = timeout.min(Duration::from_secs(5));
    let _ = s.set_read_timeout(Some(io));
    let _ = s.set_write_timeout(Some(io));
    if let (Ok(mut l), Ok(c)) = (live.lock(), s.try_clone()) {
        l.push((id, c));
    }
    let response = match read(&s, Instant::now() + timeout) {
        Ok(req) => std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handler(&req)))
            .unwrap_or_else(|_| Response::text(500, "internal error")),
        Err(r) => r,
    };
    let _ = write(&mut s, &response);
    let _ = s.shutdown(Shutdown::Both);
    if let Ok(mut l) = live.lock() {
        l.retain(|(i, _)| *i != id);
    }
}
