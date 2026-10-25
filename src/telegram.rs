//! Telegram (LOOP-16, loop.md **Telegram**): the Bot API's `sendMessage` and `getUpdates`
//! (`http`), and my messages parsed into commands. Failures are logged once per outage, the
//! token masked, and never raised: the loop goes on and the outbox retries.

use serde_json::{Value, json};

use crate::commands::Cmd;
use crate::config::TelegramConfig;
use crate::http::{self, TIMEOUT};
use crate::outbox::{self, Sender};

/// The reply to `help`, `start` and anything [`parse`] refuses.
pub const HELP: &str =
    "commands: status · next · approve <id> · retry <id> · release <id> · pause · resume";

/// A message from `getUpdates`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Update {
    pub id: i64,
    /// `message.chat.id`, as a string.
    pub chat: String,
    pub text: Option<String>,
    /// `message.date` (unix s).
    pub date: Option<i64>,
}

/// What a message asks for.
#[derive(Debug, Clone, PartialEq)]
pub enum TgCommand {
    Status,
    Next,
    Help,
    /// A `commands` row.
    Cmd(Cmd),
}

/// `[/]command[@bot] args`: the command ASCII case-insensitive, runs of spaces one; `Err` (the
/// reply is [`HELP`]) for an unknown command or the wrong arguments.
pub fn parse(text: &str) -> Result<TgCommand, String> {
    let mut words = text.split_whitespace();
    let first = words.next().ok_or("empty message")?;
    let first = first.strip_prefix('/').unwrap_or(first);
    let command = first
        .split('@')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let args: Vec<&str> = words.collect();
    let bad = || format!("{command}: bad arguments");
    let none = |c: TgCommand| if args.is_empty() { Ok(c) } else { Err(bad()) };
    let one = |f: fn(String) -> Cmd| match args.as_slice() {
        [id] => Ok(TgCommand::Cmd(f(id.to_string()))),
        _ => Err(bad()),
    };
    match command.as_str() {
        "status" => none(TgCommand::Status),
        "next" => none(TgCommand::Next),
        "help" | "start" => none(TgCommand::Help),
        "pause" => none(TgCommand::Cmd(Cmd::Pause)),
        "resume" => none(TgCommand::Cmd(Cmd::Resume)),
        "approve" => one(Cmd::Approve),
        "release" => one(Cmd::Release),
        "retry" => match args.as_slice() {
            [id] | ["--fresh", id] if *id != "--fresh" => {
                Ok(TgCommand::Cmd(Cmd::RetryFresh(id.to_string())))
            }
            _ => Err(bad()),
        },
        other => Err(format!("unknown command {other:?}")),
    }
}

/// The Bot API with `[telegram]`.
#[derive(Debug)]
pub struct Telegram {
    config: TelegramConfig,
    /// A failure was logged and nothing has worked since.
    down: bool,
    /// Every line logged to stderr (tests read it).
    pub logged: Vec<String>,
}

impl Telegram {
    pub fn new(config: &TelegramConfig) -> Telegram {
        Telegram {
            config: config.clone(),
            down: false,
            logged: Vec::new(),
        }
    }

    pub fn chat_id(&self) -> &str {
        &self.config.chat_id
    }

    /// `POST <api_base>/bot<token>/<method>`: success = HTTP 200 and `ok: true` → `result`.
    fn call(&mut self, method: &str, body: Value) -> Result<Value, String> {
        let url = format!(
            "{}/bot{}/{method}",
            self.config.api_base, self.config.bot_token
        );
        let r = match http::post_json(&url, &[], &body, TIMEOUT) {
            Ok((200, v)) if v.get("ok") == Some(&Value::Bool(true)) => {
                Ok(v.get("result").cloned().unwrap_or(Value::Null))
            }
            Ok((code, v)) => Err(format!(
                "HTTP {code}: {}",
                v.get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("ok is not true")
            )),
            Err(e) => Err(e.to_string()),
        };
        let r = r.map_err(|e| {
            let e = http::mask(&e).replace(&self.config.bot_token, "<token>");
            format!("telegram {method}: {}", outbox::one_line(&e))
        });
        match &r {
            Ok(_) => self.down = false,
            Err(e) if !self.down => {
                self.down = true;
                crate::tlog!("towercab: {e}");
                self.logged.push(e.clone());
            }
            Err(_) => {}
        }
        r
    }

    /// `sendMessage` `{chat_id, text, disable_web_page_preview: true}`, text ≤ 4000 chars.
    pub fn send(&mut self, text: &str) -> Result<(), String> {
        let body = json!({
            "chat_id": self.config.chat_id,
            "text": outbox::cut(text, outbox::MAX),
            "disable_web_page_preview": true,
        });
        self.call("sendMessage", body).map(drop)
    }

    /// `getUpdates` `{offset, timeout: 0, allowed_updates: ["message"]}` (no `offset` the
    /// first time) → the messages, oldest first.
    pub fn updates(&mut self, offset: Option<i64>) -> Result<Vec<Update>, String> {
        let mut body = json!({"timeout": 0, "allowed_updates": ["message"]});
        if let Some(o) = offset {
            body["offset"] = json!(o);
        }
        let result = self.call("getUpdates", body)?;
        let list = result
            .as_array()
            .ok_or("telegram getUpdates: result is not a list")?;
        let mut out = Vec::new();
        for u in list {
            let Some(id) = u.get("update_id").and_then(Value::as_i64) else {
                continue;
            };
            let msg = u.get("message");
            let chat = match msg.and_then(|m| m.pointer("/chat/id")) {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Number(n)) => n.to_string(),
                _ => String::new(),
            };
            let text = msg
                .and_then(|m| m.get("text"))
                .and_then(Value::as_str)
                .map(str::to_string);
            let date = msg.and_then(|m| m.get("date")).and_then(Value::as_i64);
            out.push(Update {
                id,
                chat,
                text,
                date,
            });
        }
        out.sort_by_key(|u| u.id);
        Ok(out)
    }
}

impl Sender for Telegram {
    fn send(&mut self, text: &str) -> Result<(), String> {
        Telegram::send(self, text)
    }
}
