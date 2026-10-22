//! A fake HTTP server on 127.0.0.1 (one request per connection) and, on it, a fake Telegram
//! Bot API that records every call and answers from a script.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};

/// A request as the server read it.
#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub body: String,
    /// (name lowercased, value), in order.
    pub headers: Vec<(String, String)>,
}

impl Request {
    /// The value of header `name` (any case).
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

type Handler = Box<dyn FnMut(&Request) -> (u16, String) + Send>;

/// Serves until dropped (the listener thread exits with the test process).
pub struct FakeHttp {
    pub url: String,
    pub requests: Arc<Mutex<Vec<Request>>>,
}

fn read_request(stream: &mut TcpStream) -> Option<Request> {
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut r = BufReader::new(stream.try_clone().ok()?);
    let mut line = String::new();
    r.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();
    let mut len = 0usize;
    let mut headers = Vec::new();
    loop {
        let mut h = String::new();
        r.read_line(&mut h).ok()?;
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            if k.eq_ignore_ascii_case("content-length") {
                len = v.trim().parse().ok()?;
            }
            headers.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
        }
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).ok()?;
    Some(Request {
        method,
        path,
        body: String::from_utf8_lossy(&body).into_owned(),
        headers,
    })
}

impl FakeHttp {
    pub fn start(handler: impl FnMut(&Request) -> (u16, String) + Send + 'static) -> FakeHttp {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&requests);
        let handler: Arc<Mutex<Handler>> = Arc::new(Mutex::new(Box::new(handler)));
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let Some(req) = read_request(&mut stream) else {
                    continue;
                };
                seen.lock().unwrap().push(req.clone());
                let (code, body) = (handler.lock().unwrap())(&req);
                let reply = format!(
                    "HTTP/1.1 {code} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(reply.as_bytes());
                let _ = stream.flush();
            }
        });
        FakeHttp { url, requests }
    }
}

/// A port nothing listens on: every call is refused.
pub fn dead_url() -> String {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", l.local_addr().unwrap());
    drop(l);
    url
}

/// What the fake Bot API answers.
#[derive(Debug, Default)]
pub struct TgState {
    /// (method, JSON body) of every call.
    pub calls: Vec<(String, Value)>,
    /// Texts `sendMessage` accepted.
    pub sent: Vec<String>,
    /// Updates `getUpdates` hands out (those with `update_id` ≥ its `offset`).
    pub updates: Vec<Value>,
    /// The next this many `sendMessage` calls answer 500.
    pub send_fails: usize,
    /// Every call answers this status with `ok: false` (502, or 200 for an `ok: false` body).
    pub down: Option<u16>,
}

pub struct FakeTelegram {
    pub http: FakeHttp,
    pub state: Arc<Mutex<TgState>>,
}

pub const TOKEN: &str = "123:SECRET-token";
pub const CHAT: &str = "4242";

impl FakeTelegram {
    pub fn start() -> FakeTelegram {
        let state = Arc::new(Mutex::new(TgState::default()));
        let st = Arc::clone(&state);
        let http = FakeHttp::start(move |req| {
            let mut s = st.lock().unwrap();
            let body: Value = serde_json::from_str(&req.body).unwrap_or(Value::Null);
            let method = req.path.rsplit('/').next().unwrap_or_default().to_string();
            assert!(
                req.path.starts_with(&format!("/bot{TOKEN}/")),
                "{}",
                req.path
            );
            s.calls.push((method.clone(), body.clone()));
            if let Some(code) = s.down {
                return (
                    code,
                    json!({"ok": false, "description": "down"}).to_string(),
                );
            }
            match method.as_str() {
                "sendMessage" if s.send_fails > 0 => {
                    s.send_fails -= 1;
                    (500, json!({"ok": false, "description": "boom"}).to_string())
                }
                "sendMessage" => {
                    s.sent
                        .push(body["text"].as_str().unwrap_or_default().to_string());
                    (200, json!({"ok": true, "result": {}}).to_string())
                }
                "getUpdates" => {
                    let offset = body.get("offset").and_then(Value::as_i64).unwrap_or(0);
                    let result: Vec<Value> = s
                        .updates
                        .iter()
                        .filter(|u| u["update_id"].as_i64().unwrap() >= offset)
                        .cloned()
                        .collect();
                    (200, json!({"ok": true, "result": result}).to_string())
                }
                _ => (404, json!({"ok": false}).to_string()),
            }
        });
        FakeTelegram { http, state }
    }

    /// `[telegram]` for this fake.
    pub fn config(&self) -> towercab::config::TelegramConfig {
        towercab::config::TelegramConfig {
            bot_token: TOKEN.into(),
            chat_id: CHAT.into(),
            api_base: self.http.url.clone(),
        }
    }

    /// Queues a message from `chat` (`None` text: a sticker); returns its update id.
    pub fn message(&self, chat: &str, text: Option<&str>) -> i64 {
        let mut s = self.state.lock().unwrap();
        let id = 100 + s.updates.len() as i64;
        let mut msg = json!({"message_id": id, "chat": {"id": chat.parse::<i64>().unwrap()}});
        if let Some(t) = text {
            msg["text"] = json!(t);
        }
        s.updates.push(json!({"update_id": id, "message": msg}));
        id
    }

    pub fn sent(&self) -> Vec<String> {
        self.state.lock().unwrap().sent.clone()
    }

    /// Calls of `method`, their bodies.
    pub fn calls(&self, method: &str) -> Vec<Value> {
        self.state
            .lock()
            .unwrap()
            .calls
            .iter()
            .filter(|(m, _)| m == method)
            .map(|(_, b)| b.clone())
            .collect()
    }

    pub fn fail_sends(&self, n: usize) {
        self.state.lock().unwrap().send_fails = n;
    }

    pub fn down(&self, code: Option<u16>) {
        self.state.lock().unwrap().down = code;
    }
}
