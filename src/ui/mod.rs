//! The local web UI ([UI](../specs/ui.md)): what Towercab is doing now, and the CLI's commands
//! as buttons. Served by the loop on its own threads (UI-1) or by `towercab ui` (UI-2).

pub mod pages;
pub mod wire;

use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::commands::{self, Cmd};
use crate::config::Config;
use crate::db::{Db, sql};
use crate::exes::Exes;
use crate::home::Home;
use crate::intents::store;
use crate::machine::{self, Kind, Stage};
use crate::mission::{self, Mission};
use crate::pick;
use crate::runloop::{Tick, shown_time};
use crate::status::Snapshot;
use wire::{Request, Response, Server};

/// How long a POST waits for the loop to apply its command (UI-6).
pub const REPLY_WAIT: Duration = Duration::from_secs(6);
/// The log tail's lines and cache (UI-11).
pub const LOG_LINES: usize = 200;
pub const LOG_CACHE: Duration = Duration::from_secs(10);
/// A run file's shown tail (UI-10).
pub const RUN_FILE_MAX: u64 = 512 << 10;

/// The log tail and when it was read.
type LogCache = Mutex<Option<(Instant, Vec<(String, bool)>)>>;

/// A rendered piece kept a while.
type Cache = Mutex<Option<(Instant, String)>>;

/// Spend today and this week from Prometheus, kept [`COST_CACHE`].
pub const COST_CACHE: Duration = Duration::from_secs(60);

/// What every request reads from.
pub struct Ctx {
    pub config: Config,
    pub home: Home,
    pub exes: Exes,
    /// 32 random bytes, hex (UI-4).
    pub token: String,
    /// The port served, for the `Host` check.
    pub port: Mutex<u16>,
    /// `false` when `towercab ui` serves a stopped loop: actions off.
    pub actions: bool,
    /// How long a POST waits for the loop's reply ([`REPLY_WAIT`]).
    pub reply_wait: Duration,
    /// The GitHub App (the repos panel's install check).
    pub identity: crate::github::Identity,
    /// Where intent edits go (UI-14).
    pub writer: Arc<dyn crate::intents::edit::IntentWriter>,
    log: LogCache,
    pub(crate) repos_cache: Cache,
    cost_cache: Cache,
}

impl Ctx {
    pub fn new(config: Config, home: Home, exes: Exes, actions: bool) -> Ctx {
        let identity = crate::github::Identity::from_config(&config, &exes);
        let auth_id = identity.clone();
        let remote = config.intents.remote.clone().unwrap_or_default();
        let auth: Arc<dyn Fn() -> Option<crate::intents::git::AuthFn> + Send + Sync> =
            Arc::new(move || {
                let (id, url) = (auth_id.clone(), remote.clone());
                id.is_app().then(|| {
                    Box::new(move || id.auth_for_url(&url).map_err(|e| e.to_string()))
                        as crate::intents::git::AuthFn
                })
            });
        let writer: Arc<dyn crate::intents::edit::IntentWriter> =
            Arc::new(crate::intents::edit::GitWriter {
                config: config.clone(),
                auth: Some(auth),
            });
        Self::with_writer(config, home, exes, actions, writer, identity)
    }

    /// [`Ctx::new`] with another intent writer (tests; a database later).
    pub fn with_writer(
        config: Config,
        home: Home,
        exes: Exes,
        actions: bool,
        writer: Arc<dyn crate::intents::edit::IntentWriter>,
        identity: crate::github::Identity,
    ) -> Ctx {
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        Ctx {
            config,
            home,
            exes,
            token,
            port: Mutex::new(0),
            actions,
            reply_wait: REPLY_WAIT,
            identity: identity.clone(),
            writer,
            log: Mutex::new(None),
            repos_cache: Mutex::new(None),
            cost_cache: Mutex::new(None),
        }
    }

    /// Buttons and edits work: the loop's own UI while the loop holds the home.
    pub fn can_act(&self) -> bool {
        self.actions && self.home.holder().is_some()
    }
}

/// Starts the UI on `port` (UI-1, UI-2): `127.0.0.1` only.
pub fn serve(ctx: Arc<Ctx>, port: u16) -> Result<Server, String> {
    let c = ctx.clone();
    let server = Server::start(
        port,
        Arc::new(move |r| route(&c, r)),
        Duration::from_secs(10),
    )?;
    if let Ok(mut p) = ctx.port.lock() {
        *p = server.port;
    }
    Ok(server)
}

/// The loop's UI server (UI-1): stopped and joined when dropped.
pub struct Running(Option<Server>);

impl Running {
    /// `127.0.0.1:<[ui] port>` with actions on; a bind failure is logged, `None`.
    pub fn start(config: &Config, home: &Home, exes: &Exes) -> Option<Running> {
        let ctx = Arc::new(Ctx::new(config.clone(), home.clone(), exes.clone(), true));
        match serve(ctx, config.ui.port) {
            Ok(s) => Some(Running(Some(s))),
            Err(e) => {
                eprintln!("towercab: ui: {e}");
                None
            }
        }
    }

    pub fn port(&self) -> u16 {
        self.0.as_ref().map_or(0, |s| s.port)
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        if let Some(s) = self.0.take() {
            s.stop();
        }
    }
}

/// `GET /api/ping` on `127.0.0.1:<port>` answers `towercab …` within 2 s (UI-2).
pub fn answers(port: u16) -> bool {
    use std::io::{Read, Write};
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut s) = std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(2)) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
    let req = format!("GET /api/ping HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n");
    if s.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut out = String::new();
    let _ = s.read_to_string(&mut out);
    out.contains("\r\n\r\ntowercab ")
}

/// The routes, after the `Host` check (UI-4).
pub fn route(ctx: &Ctx, r: &Request) -> Response {
    let port = ctx.port.lock().map(|p| *p).unwrap_or(0);
    let host_ok = r.header("host").is_some_and(|h| {
        [
            format!("127.0.0.1:{port}"),
            format!("localhost:{port}"),
            format!("[::1]:{port}"),
        ]
        .contains(&h.to_string())
    });
    if !host_ok {
        return Response::text(421, "wrong Host");
    }
    let path = r.path.split('?').next().unwrap_or("/");
    match (r.method.as_str(), path) {
        ("GET", "/") => page(ctx),
        ("GET", "/api/ping") => {
            Response::text(200, &format!("towercab {}", env!("CARGO_PKG_VERSION")))
        }
        ("GET", "/api/state") => match state(ctx) {
            Ok(v) => Response::json(&v),
            Err(e) => Response::text(500, &e),
        },
        ("POST", "/api/cmd") => action(ctx, r),
        ("POST", "/api/intent") => pages::intent_api(ctx, r),
        ("GET", "/intents") => pages::intents_page(ctx).unwrap_or_else(|e| Response::text(500, &e)),
        ("GET", "/repos") => pages::repos_page(ctx, r.path.contains("?fresh"))
            .unwrap_or_else(|e| Response::text(500, &e)),
        ("GET", p) if p.starts_with("/i/") => {
            pages::intent_page(ctx, &p[3..]).unwrap_or_else(|e| Response::text(500, &e))
        }
        ("GET", p) if p.starts_with("/m/") => mission_route(ctx, &p[3..]),
        (_, "/api/cmd") | (_, "/") | (_, "/api/state") => Response::text(405, "method"),
        _ => Response::text(404, "not found"),
    }
}

// ---------- escaping, redaction ----------

/// HTML-escaped text.
pub fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

/// A link, only for `http(s)://` targets; else the escaped text.
pub(crate) fn link(url: Option<&str>, text: &str) -> String {
    match url {
        Some(u) if u.starts_with("https://") || u.starts_with("http://") => {
            format!(
                "<a href=\"{}\" target=\"_blank\" rel=\"noopener\">{}</a>",
                esc(u),
                esc(text)
            )
        }
        _ => String::new(),
    }
}

/// Text with secrets taken out (UI-5): the Telegram bot token, GitHub tokens, private keys,
/// each repo's e2e secret values.
pub fn redact(ctx: &Ctx, text: &str) -> String {
    let mut out = text.to_string();
    if let Some(t) = &ctx.config.telegram
        && !t.bot_token.is_empty()
    {
        out = out.replace(&t.bot_token, "<token>");
    }
    let gh = regex::Regex::new(r"\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b")
        .expect("static regex");
    out = gh.replace_all(&out, "<token>").into_owned();
    let pem = regex::Regex::new(
        r"(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----",
    )
    .expect("static regex");
    out = pem.replace_all(&out, "<private key>").into_owned();
    for name in ctx.config.repos.keys() {
        let file = crate::pipeline::e2e::secrets_file(&ctx.config, name);
        if let Ok(kv) = crate::pipeline::e2e::secrets(&file) {
            for (_, v) in kv.into_iter().filter(|(_, v)| v.len() >= 3) {
                out = out.replace(&v, "[redacted]");
            }
        }
    }
    out
}

// ---------- state ----------

pub(crate) fn when(at: f64, now: &Tick) -> String {
    shown_time(at, now.wall)
}

pub(crate) fn ago(at: f64, now: &Tick) -> String {
    dur((now.unix() - at).max(0.0) as i64)
}

/// `42s`, `5m`, `2h 3m`, `3d`.
pub(crate) fn dur(s: i64) -> String {
    match s {
        0..=59 => format!("{s}s"),
        60..=3599 => format!("{}m", s / 60),
        3600..=86399 => format!("{}h {}m", s / 3600, (s % 3600) / 60),
        _ => format!("{}d", s / 86400),
    }
}

/// A mission's sequence, for its strip.
fn sequence(kind: Kind) -> &'static [Stage] {
    match kind {
        Kind::Intent => &machine::ORDER,
        Kind::Revert => &machine::REVERT,
        Kind::Rehearsal => &machine::REHEARSAL,
    }
}

/// The buttons a wait gets (UI-6).
fn buttons(stage: Option<Stage>) -> Vec<&'static str> {
    match stage {
        Some(Stage::ApprovalRelease) => vec!["release", "retry_fresh"],
        Some(Stage::ApprovalSpec | Stage::ApprovalMerge | Stage::Blocked) | None => {
            vec!["approve", "retry_fresh"]
        }
        _ => vec![],
    }
}

/// `/api/state` (UI-7): the facts and each section's HTML.
pub fn state(ctx: &Ctx) -> Result<Value, String> {
    let tick = Tick::now();
    let db = Db::open(&ctx.home.db())?;
    let listing = store::scan(&ctx.config.intents.path);
    let running = ctx.home.holder();
    let built = crate::handler::Handlers::production().built();
    let snap = Snapshot::read(&db, Some(&listing), None, &ctx.config, running, built, tick)?;
    let missions = mission::unfinished(db.conn())?;
    let title = |m: &Mission| {
        m.intent
            .as_deref()
            .and_then(|id| {
                listing
                    .open
                    .iter()
                    .chain(&listing.done)
                    .find(|i| i.id == id)
            })
            .map(|i| i.title().to_string())
            .unwrap_or_else(|| m.label())
    };
    let pick_state = pick::state(&db, &ctx.config, built, tick)?;
    let decision = pick::decide(&listing, &pick_state);
    let transitions = recent_transitions(&db, 50)?;
    let log = log_lines(ctx);
    let last_pass = db.meta("last_pass")?.and_then(|v| v.parse::<f64>().ok());
    let actions = ctx.actions && running.is_some();

    let lk = Links {
        ctx,
        listing: &listing,
    };
    let mut html = serde_json::Map::new();
    let cost = cost_line(ctx, &tick);
    html.insert(
        "top".into(),
        top_html(&snap, last_pass, &tick, &cost).into(),
    );
    html.insert(
        "onme".into(),
        on_me_html(&snap, &missions, actions, &lk).into(),
    );
    html.insert(
        "now".into(),
        now_html(&snap, &missions, &title, &lk, &tick).into(),
    );
    html.insert("next".into(), next_html(&decision, &listing, &lk).into());
    html.insert(
        "attention".into(),
        attention_html(&db, &snap, &tick)?.into(),
    );
    html.insert(
        "activity".into(),
        activity_html(&db, &transitions, &tick)?.into(),
    );
    html.insert("log".into(), log_html(&log).into());

    Ok(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "pid": running,
        "running": running.is_some(),
        "paused": snap.paused,
        "env_blocked": !snap.env_blocked.is_empty(),
        "actions": actions,
        "on_me_count": snap.on_me.len(),
        "now": tick.unix(),
        "on_me": snap.on_me.iter().map(|o| json!({
            "intent": o.item.id, "repo": o.item.repo, "title": o.item.title,
            "action": o.action, "pr_url": o.pr_url,
        })).collect::<Vec<_>>(),
        "missions": missions.iter().map(|m| json!({
            "id": m.id, "intent": m.intent, "repo": m.repo, "title": title(m),
            "kind": m.kind.as_str(), "stage": m.stage.as_str(), "step": m.step,
            "waiting": m.waiting, "why": m.why, "pr_url": m.pr_url,
        })).collect::<Vec<_>>(),
        "next": decision.pick,
        "skipped": decision.skipped.iter().map(|(id, s)| json!({"intent": id, "reason": s.to_string()})).collect::<Vec<_>>(),
        "log": log.iter().map(|(t, e)| json!({"text": t, "error": e})).collect::<Vec<_>>(),
        "html": html,
    }))
}

/// Links for ids and repos in the sections (UI-12).
pub(crate) struct Links<'a> {
    ctx: &'a Ctx,
    listing: &'a store::Listing,
}

impl Links<'_> {
    /// The repo, linked to GitHub.
    fn repo(&self, repo: &str) -> String {
        pages::repo_link(self.ctx, repo)
    }

    /// The intent ID, linked to its `intent.md`; a mission label as it is.
    fn intent(&self, id: &str) -> String {
        match self
            .listing
            .open
            .iter()
            .chain(&self.listing.done)
            .find(|i| i.id == id)
        {
            Some(i) => pages::intent_link(self.ctx, i),
            None => esc(id),
        }
    }

    /// The title, linked to the intent's page.
    fn title(&self, id: &str, title: &str) -> String {
        if self
            .listing
            .open
            .iter()
            .chain(&self.listing.done)
            .any(|i| i.id == id)
        {
            format!("<a href=\"/i/{}\"><b>{}</b></a>", esc(id), esc(title))
        } else {
            format!("<b>{}</b>", esc(title))
        }
    }
}

struct Transition {
    mission: i64,
    at: f64,
    from: String,
    event: String,
    to: String,
    why: Option<String>,
}

fn recent_transitions(db: &Db, n: i64) -> Result<Vec<Transition>, String> {
    let mut q = db
        .conn()
        .prepare("SELECT mission, at, from_stage, event, to_stage, why FROM transitions ORDER BY id DESC LIMIT ?1")
        .map_err(sql)?;
    q.query_map([n], |r| {
        Ok(Transition {
            mission: r.get(0)?,
            at: r.get(1)?,
            from: r.get(2)?,
            event: r.get(3)?,
            to: r.get(4)?,
            why: r.get(5)?,
        })
    })
    .map_err(sql)?
    .collect::<Result<_, _>>()
    .map_err(sql)
}

// ---------- sections ----------

fn top_html(s: &Snapshot, last_pass: Option<f64>, tick: &Tick, cost: &str) -> String {
    let state = match s.running {
        Some(pid) => format!("<span class=\"ok\">running</span> · pid {pid}"),
        None => "<span class=\"bad\">stopped</span> · <code>towercab up</code> to start".into(),
    };
    let mut out = format!("<b>Towercab</b> {} · {state}", esc(&s.version));
    if s.paused {
        out.push_str(" · <span class=\"warn\">paused</span>");
    }
    if let Some(at) = last_pass {
        let _ = write!(out, " · last pass {} ago", ago(at, tick));
    }
    for f in &s.env_blocked {
        let fix = f
            .kind
            .parse::<crate::env::Fault>()
            .map(|k| k.fix())
            .unwrap_or_default();
        let _ = write!(
            out,
            "<div class=\"bad\">env blocked: {} since {}: {} · fix: {}</div>",
            esc(&f.kind),
            esc(&when(f.since, tick)),
            esc(&f.error),
            esc(&fix)
        );
    }
    if !cost.is_empty() {
        let _ = write!(out, " · {}", esc(cost));
    }
    out
}

/// `spend today $x · 7 d $y` from Prometheus (`towercab.cost.usd`, MET-16), kept
/// [`COST_CACHE`]; empty when Prometheus doesn't answer.
fn cost_line(ctx: &Ctx, tick: &Tick) -> String {
    if let Ok(c) = ctx.cost_cache.lock()
        && let Some((at, line)) = c.as_ref()
        && at.elapsed() < COST_CACHE
    {
        return line.clone();
    }
    let now = tick.unix();
    let sum = |window: &str| {
        let q = crate::maintain::prom::Query {
            band: "cost".into(),
            query: format!(
                "sum(sum_over_time({{__name__=~\"towercab_cost_usd(_USD)?(_total)?\"}}[{window}]))"
            ),
            start: now,
            end: now,
            step: 60,
        };
        crate::maintain::prom::query_range(
            &ctx.config.metrics.prometheus,
            &q,
            Duration::from_secs(2),
        )
        .ok()
        .and_then(|pts| pts.last().map(|p| p.1))
    };
    let line = match (sum("1d"), sum("7d")) {
        (Some(d), Some(w)) => format!("spend today ${d:.2} · 7 d ${w:.2}"),
        (Some(d), None) => format!("spend today ${d:.2}"),
        _ => String::new(),
    };
    if let Ok(mut c) = ctx.cost_cache.lock() {
        *c = Some((Instant::now(), line.clone()));
    }
    line
}

fn on_me_html(s: &Snapshot, missions: &[Mission], actions: bool, lk: &Links) -> String {
    if s.on_me.is_empty() {
        return "<p class=\"dim\">Nothing waits on you.</p>".into();
    }
    let mut out = String::from("<ul>");
    for o in &s.on_me {
        let m = missions.iter().find(|m| m.label() == o.item.id);
        let id = m
            .and_then(|m| m.intent.clone())
            .unwrap_or_else(|| o.item.id.clone());
        let why = m.and_then(|m| m.why.clone()).unwrap_or_default();
        let _ = write!(
            out,
            "<li>{} <span class=\"dim\">{} · {}</span><br>{}",
            lk.title(&id, &o.item.title),
            lk.intent(&id),
            lk.repo(&o.item.repo),
            esc(&o.action)
        );
        if !why.is_empty() {
            let _ = write!(out, "<br><span class=\"dim\">{}</span>", esc(&why));
        }
        let pr = link(o.pr_url.as_deref(), "PR");
        if !pr.is_empty() {
            let _ = write!(out, " · {pr}");
        }
        if let Some(m) = m {
            let _ = write!(out, " · <a href=\"/m/{}\">details</a>", m.id);
        }
        if actions {
            out.push_str("<div class=\"btns\">");
            for b in buttons(m.map(|m| m.stage)) {
                let label = match b {
                    "approve" => "Approve",
                    "release" => "Release",
                    _ => "Retry fresh",
                };
                let _ = write!(
                    out,
                    "<button data-cmd=\"{b}\" data-arg=\"{}\">{label}</button>",
                    esc(&id)
                );
            }
            out.push_str("</div>");
        }
        out.push_str("</li>");
    }
    out.push_str("</ul>");
    out
}

fn now_html(
    s: &Snapshot,
    missions: &[Mission],
    title: &dyn Fn(&Mission) -> String,
    lk: &Links,
    tick: &Tick,
) -> String {
    let mut out = String::new();
    if s.active.is_empty() {
        out.push_str("<p class=\"dim\">No Claude run or check is running.</p>");
    } else {
        out.push_str("<ul>");
        for a in &s.active {
            let _ = write!(
                out,
                "<li class=\"active\"><b>{}</b> <span class=\"dim\">{} · {}</span><br>{}{} · for {}</li>",
                esc(&a.item.title),
                esc(&a.item.id),
                lk.repo(&a.item.repo),
                esc(a.stage.as_str()),
                a.model
                    .as_deref()
                    .map(|m| format!(" · {}", esc(m)))
                    .unwrap_or_default(),
                ago(a.since, tick)
            );
        }
        out.push_str("</ul>");
    }
    for m in missions {
        let seq = sequence(m.kind);
        let at = if seq.contains(&m.stage) {
            Some(m.stage)
        } else {
            m.from_stage
        };
        let pos = at.and_then(|a| seq.iter().position(|s| *s == a));
        let _ = write!(
            out,
            "<div class=\"mission\"><a href=\"/m/{}\"><b>{}</b></a> <span class=\"dim\">{} · {} · attempt {}</span><div class=\"strip\">",
            m.id,
            esc(&title(m)),
            m.intent
                .as_deref()
                .map_or_else(|| esc(&m.label()), |i| lk.intent(i)),
            lk.repo(&m.repo),
            m.attempt
        );
        for (i, st) in seq.iter().enumerate() {
            let class = match pos {
                Some(p) if i < p => "done",
                Some(p) if i == p => {
                    if m.stage.waits() {
                        "wait"
                    } else {
                        "here"
                    }
                }
                _ => "todo",
            };
            let _ = write!(out, "<span class=\"{class}\">{}</span>", esc(st.as_str()));
        }
        out.push_str("</div>");
        let mut notes = Vec::new();
        if m.stage.waits() {
            notes.push(format!(
                "waiting: {}",
                m.waiting.as_deref().unwrap_or(m.stage.as_str())
            ));
        }
        if !m.step.is_empty() {
            notes.push(format!("step {}", m.step));
        }
        if let Some(model) = &m.limit_model {
            notes.push(format!("{model} cooling (usage limit)"));
        }
        if let Some(at) = m.retry_at {
            notes.push(format!("retry at {}", when(at, tick)));
        }
        if m.held {
            notes.push("held: resume".into());
        }
        if let Some(f) = &m.fault {
            notes.push(format!("fault {f}"));
        }
        if m.cost_usd > 0.0 {
            notes.push(format!("${:.2}", m.cost_usd));
        }
        let pr = link(m.pr_url.as_deref(), "PR");
        let _ = write!(
            out,
            "<div class=\"dim\">{}{}</div></div>",
            esc(&notes.join(" · ")),
            if pr.is_empty() {
                String::new()
            } else {
                format!(" · {pr}")
            }
        );
    }
    if missions.is_empty() {
        out.push_str("<p class=\"dim\">No mission in flight.</p>");
    }
    out
}

fn next_html(d: &pick::Decision, listing: &store::Listing, lk: &Links) -> String {
    let line = |id: &str| match listing.open.iter().find(|i| i.id == id) {
        Some(i) => format!(
            "{} <span class=\"dim\">{} · {}</span>",
            lk.title(id, i.title()),
            lk.intent(id),
            lk.repo(i.repo())
        ),
        None => esc(id),
    };
    let mut out = match &d.pick {
        Some(id) => format!("<p>Next: {}</p>", line(id)),
        None => "<p class=\"dim\">Nothing runnable.</p>".into(),
    };
    if !d.skipped.is_empty() {
        out.push_str("<ul>");
        for (id, why) in &d.skipped {
            let _ = write!(out, "<li>{} · {}</li>", line(id), esc(&why.to_string()));
        }
        out.push_str("</ul>");
    }
    out
}

fn attention_html(db: &Db, s: &Snapshot, tick: &Tick) -> Result<String, String> {
    let mut items = Vec::new();
    for c in &s.cooling {
        items.push(format!(
            "{} cooling until {} (usage limit, in {})",
            c.model,
            when(c.until, tick),
            dur((c.until - tick.unix()).max(0.0) as i64)
        ));
    }
    for f in crate::env::faults(db.conn())? {
        items.push(format!(
            "fault {}: {} (since {})",
            f.kind,
            f.error,
            when(f.since, tick)
        ));
    }
    for c in &s.caps {
        items.push(format!(
            "{} {}: {} · trust {} when fixed",
            c.repo,
            if c.frozen { "frozen" } else { "capped at a3" },
            c.why,
            c.repo
        ));
    }
    for d in &s.drafts_failed {
        items.push(format!("draft failed: {d}"));
    }
    for (band, n) in &s.dismissed {
        items.push(format!("alert {band}: {n} dismissed"));
    }
    if s.review_due {
        items.push("backlog review due: towercab review".into());
    }
    if let Some(e) = &s.intents_error {
        items.push(format!("intents: {e}"));
    }
    if items.is_empty() {
        return Ok("<p class=\"dim\">Nothing needs attention.</p>".into());
    }
    let mut out = String::from("<ul>");
    for i in items {
        let _ = write!(out, "<li>{}</li>", esc(&i));
    }
    out.push_str("</ul>");
    Ok(out)
}

fn activity_html(db: &Db, ts: &[Transition], tick: &Tick) -> Result<String, String> {
    let mut out =
        String::from("<table><tr><th>when</th><th>mission</th><th>move</th><th>why</th></tr>");
    for t in ts {
        let _ = write!(
            out,
            "<tr><td>{}</td><td><a href=\"/m/{}\">{}</a></td><td>{} → {} <span class=\"dim\">({})</span></td><td>{}</td></tr>",
            esc(&when(t.at, tick)),
            t.mission,
            t.mission,
            esc(&t.from),
            esc(&t.to),
            esc(&t.event),
            esc(t.why.as_deref().unwrap_or(""))
        );
    }
    out.push_str("</table>");
    if ts.is_empty() {
        out = "<p class=\"dim\">No moves yet.</p>".into();
    }
    let mut q = db
        .conn()
        .prepare("SELECT text, created, sent_at FROM outbox ORDER BY created DESC LIMIT 10")
        .map_err(sql)?;
    let rows: Vec<(String, f64, Option<f64>)> = q
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(sql)?
        .collect::<Result<_, _>>()
        .map_err(sql)?;
    if !rows.is_empty() {
        out.push_str("<h3>Messages</h3><ul>");
        for (text, created, sent) in rows {
            let state = match sent {
                Some(s) if s > 0.0 => "sent",
                Some(_) => "dropped",
                None => "pending",
            };
            let _ = write!(
                out,
                "<li><span class=\"dim\">{} · {state}</span> {}</li>",
                esc(&when(created, tick)),
                esc(text.lines().next().unwrap_or(""))
            );
        }
        out.push_str("</ul>");
    }
    Ok(out)
}

fn log_html(lines: &[(String, bool)]) -> String {
    let mut out = String::from("<pre class=\"log\">");
    for (l, err) in lines {
        if *err {
            let _ = writeln!(out, "<span class=\"bad\">{}</span>", esc(l));
        } else {
            let _ = writeln!(out, "{}", esc(l));
        }
    }
    out.push_str("</pre>");
    out
}

/// The loop's last journal lines, redacted, errors flagged (UI-11); cached [`LOG_CACHE`].
pub fn log_lines(ctx: &Ctx) -> Vec<(String, bool)> {
    if let Ok(cache) = ctx.log.lock()
        && let Some((at, lines)) = cache.as_ref()
        && at.elapsed() < LOG_CACHE
    {
        return lines.clone();
    }
    let mut cmd = std::process::Command::new(&ctx.exes.journalctl);
    cmd.args([
        "--user",
        "-u",
        "towercab",
        "-n",
        &LOG_LINES.to_string(),
        "-o",
        "short-iso",
        "--no-pager",
    ]);
    let flag = regex::Regex::new(r"(?i)error|failed|panic|unexpected").expect("static regex");
    let lines = match crate::child::output(&mut cmd, Duration::from_secs(5)) {
        Ok(o) if o.status.success() => {
            let text = redact(ctx, &String::from_utf8_lossy(&o.stdout));
            let v: Vec<(String, bool)> = text
                .lines()
                .map(|l| (l.to_string(), flag.is_match(l)))
                .collect();
            if v.is_empty() {
                vec![("no log lines yet".to_string(), false)]
            } else {
                v
            }
        }
        Ok(o) => vec![(
            format!("journalctl: exit {}", o.status.code().unwrap_or(-1)),
            true,
        )],
        Err(e) => vec![(format!("journalctl: {e}"), true)],
    };
    if let Ok(mut cache) = ctx.log.lock() {
        *cache = Some((Instant::now(), lines.clone()));
    }
    lines
}

// ---------- actions ----------

/// A POST's `Origin` and token (UI-4); `Err` = the 403 to send.
pub(crate) fn post_ok(ctx: &Ctx, r: &Request) -> Result<(), Response> {
    let port = ctx.port.lock().map(|p| *p).unwrap_or(0);
    let host = r.header("host").unwrap_or_default();
    if r.header("origin") != Some(&format!("http://{host}")) || host.is_empty() || port == 0 {
        return Err(Response::text(403, "bad Origin"));
    }
    let token = r.header("x-towercab-token").unwrap_or_default();
    if !constant_eq(token.as_bytes(), ctx.token.as_bytes()) {
        return Err(Response::text(403, "bad token"));
    }
    Ok(())
}

fn action(ctx: &Ctx, r: &Request) -> Response {
    if let Err(resp) = post_ok(ctx, r) {
        return resp;
    }
    if !ctx.can_act() {
        return Response::text(409, "towercab isn't running: towercab up");
    }
    let Ok(body) = serde_json::from_slice::<Value>(&r.body) else {
        return Response::text(400, "JSON body");
    };
    let arg = body.get("arg").and_then(Value::as_str).unwrap_or("");
    let arg_ok = !arg.is_empty()
        && arg.len() <= 64
        && arg
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c));
    let cmd = match (body.get("cmd").and_then(Value::as_str), arg_ok) {
        (Some("approve"), true) => Cmd::Approve(arg.into()),
        (Some("retry_fresh"), true) => Cmd::RetryFresh(arg.into()),
        (Some("release"), true) => Cmd::Release(arg.into()),
        (Some("trust"), true) => Cmd::Trust(arg.into()),
        (Some("pause"), _) if arg.is_empty() => Cmd::Pause,
        (Some("resume"), _) if arg.is_empty() => Cmd::Resume,
        _ => return Response::text(400, "unknown command or argument"),
    };
    let db = match Db::open(&ctx.home.db()) {
        Ok(db) => db,
        Err(e) => return Response::text(500, &e),
    };
    match commands::queue(&db, &cmd, "ui") {
        Ok(id) => {
            let result = commands::wait_result(&db, id, ctx.reply_wait);
            Response::json(&json!({"id": id, "result": result}))
        }
        Err(e) => Response::text(500, &e),
    }
}

fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

// ---------- the page ----------

const STYLE: &str = r#":root{--bg:#fff;--fg:#1a1a1a;--dim:#6b6b6b;--line:#e4e4e4;--ok:#137333;--bad:#c5221f;--warn:#b06000;--here:#1a73e8;--card:#f7f7f8}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#e8e8e8;--dim:#9a9a9a;--line:#2c2c2c;--ok:#81c995;--bad:#f28b82;--warn:#fdd663;--here:#8ab4f8;--card:#1d1d1f}}
body{background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif;margin:0 auto;max-width:1100px;padding:12px 16px}
h2{font-size:15px;text-transform:uppercase;letter-spacing:.04em;color:var(--dim);margin:22px 0 6px}
section{border-top:1px solid var(--line)}ul{padding-left:18px}li{margin:6px 0}
.dim{color:var(--dim)}.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}a{color:var(--here)}
.mission{background:var(--card);border-radius:8px;padding:8px 10px;margin:8px 0}
.strip{display:flex;flex-wrap:wrap;gap:3px;margin:6px 0}.strip span{font-size:12px;padding:1px 6px;border-radius:4px;border:1px solid var(--line)}
.strip .done{color:var(--dim)}.strip .here{background:var(--here);color:var(--bg);border-color:var(--here)}.strip .wait{background:var(--warn);color:var(--bg);border-color:var(--warn)}.strip .todo{opacity:.45}
.btns{margin-top:6px}button{font:inherit;padding:4px 12px;margin-right:6px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{text-align:left;padding:3px 6px;border-bottom:1px solid var(--line);vertical-align:top}
pre.log{font-size:12px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;background:var(--card);padding:8px;border-radius:8px;max-height:420px;overflow-y:auto}
#reply{position:fixed;bottom:12px;right:12px;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 12px;display:none}
#ctl{float:right}nav{margin-bottom:10px}.danger{color:var(--bad)}
select,input{font:inherit;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:4px;padding:2px 4px}
form.edit{display:inline-flex;gap:4px;align-items:center;flex-wrap:wrap}.md p{margin:4px 0}"#;

const SCRIPT: &str = r#"const T=document.querySelector('meta[name=towercab-token]').content;
const S=['top','onme','now','next','attention','activity','log'];const BASE=document.title;
function show(t){const r=document.getElementById('reply');r.textContent=t;r.style.display='block';setTimeout(()=>r.style.display='none',6000)}
function logEl(){return document.querySelector('#log pre')}
function atBottom(e){return e.scrollHeight-e.scrollTop-e.clientHeight<24}
function bottom(){const l=logEl();if(l)l.scrollTop=l.scrollHeight}
async function poll(){try{const r=await fetch('/api/state',{cache:'no-store'});if(!r.ok)throw new Error(r.status);const s=await r.json();
const l=logEl();const stick=!l||atBottom(l);
for(const k of S){const e=document.getElementById(k);if(e&&e.innerHTML!==s.html[k])e.innerHTML=s.html[k]}
if(stick)bottom();document.title=(s.on_me_count?'('+s.on_me_count+') ':'')+BASE;
const c=document.getElementById('ctl');if(c){c.hidden=!s.actions;document.getElementById('pause').hidden=s.paused;document.getElementById('resume').hidden=!s.paused}}
catch(e){const t=document.getElementById('top');if(t)t.textContent='Towercab UI: no answer ('+e.message+')'}}
function post(u,b){return fetch(u,{method:'POST',headers:{'Content-Type':'application/json','X-Towercab-Token':T},body:JSON.stringify(b)})}
async function cmd(c,a){if((c==='retry_fresh'||c==='release')&&!confirm(c.replace('_',' ')+' '+a+'?'))return;
const r=await post('/api/cmd',{cmd:c,arg:a||''});
const t=r.ok?((await r.json()).result||'queued: applied on the loop\'s next pass'):await r.text();show(t);poll()}
async function intent(f,op){const b={op};for(const el of f.elements){if(el.name)b[el.name]=el.value}if(f.dataset.id)b.id=f.dataset.id;
if(op==='drop'&&!confirm('drop '+b.id+'?'))return;
const r=await post('/api/intent',b);const j=r.ok?await r.json():null;show(j?j.reply:await r.text());if(j&&j.ok)setTimeout(()=>location.reload(),900)}
document.addEventListener('click',e=>{const b=e.target.closest('button[data-cmd]');if(b){cmd(b.dataset.cmd,b.dataset.arg);return}
const o=e.target.closest('button[data-op]');if(o){e.preventDefault();intent(o.closest('form'),o.dataset.op)}});
document.addEventListener('submit',e=>e.preventDefault());
bottom();poll();setInterval(poll,3000);"#;

fn csp_hash(s: &str) -> String {
    use base64::Engine;
    let d = Sha256::digest(s.as_bytes());
    format!(
        "'sha256-{}'",
        base64::engine::general_purpose::STANDARD.encode(d)
    )
}

pub(crate) fn page_shell(ctx: &Ctx, title: &str, body: &str, script: bool) -> Response {
    let mut html = format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
         <meta name=\"towercab-token\" content=\"{}\"><title>{}</title><style>{STYLE}</style></head><body>\
         <nav><a href=\"/\">Overview</a> · <a href=\"/intents\">Intents</a> · <a href=\"/repos\">Repos</a> · \
         <a href=\"http://localhost:3000\" target=\"_blank\" rel=\"noopener\">Grafana</a></nav>{body}<div id=\"reply\"></div>",
        esc(&ctx.token),
        esc(title)
    );
    if script {
        let _ = write!(html, "<script>{SCRIPT}</script>");
    }
    html.push_str("</body></html>");
    let csp = format!(
        "default-src 'none'; style-src {}; script-src {}; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        csp_hash(STYLE),
        csp_hash(SCRIPT)
    );
    Response::new(200, "text/html; charset=utf-8", html).with("Content-Security-Policy", &csp)
}

/// `GET /` (UI-8).
pub fn page(ctx: &Ctx) -> Response {
    let (sections, error) = match state(ctx) {
        Ok(s) => (s, None),
        Err(e) => (json!({"html": {}}), Some(e)),
    };
    let h = |k: &str| sections["html"][k].as_str().unwrap_or("").to_string();
    let mut body = format!(
        "<header><span id=\"ctl\" hidden><button data-cmd=\"pause\" id=\"pause\">Pause</button><button data-cmd=\"resume\" id=\"resume\" hidden>Resume</button></span><div id=\"top\">{}</div></header>",
        h("top")
    );
    if let Some(e) = error {
        let _ = write!(body, "<p class=\"bad\">{}</p>", esc(&e));
    }
    for (id, name) in [
        ("onme", "Waiting on you"),
        ("now", "Now"),
        ("next", "Next"),
        ("attention", "Attention"),
        ("activity", "Activity"),
        ("log", "Log"),
    ] {
        let _ = write!(
            body,
            "<section><h2>{name}</h2><div id=\"{id}\">{}</div></section>",
            h(id)
        );
    }
    page_shell(ctx, "Towercab", &body, true)
}

// ---------- a mission ----------

fn mission_route(ctx: &Ctx, rest: &str) -> Response {
    let (id, file) = match rest.split_once("/runs/") {
        Some((id, f)) => (id, Some(f)),
        None => (rest, None),
    };
    let Ok(id) = id.parse::<i64>() else {
        return Response::text(404, "not found");
    };
    let db = match Db::open(&ctx.home.db()) {
        Ok(d) => d,
        Err(e) => return Response::text(500, &e),
    };
    let Ok(m) = mission::get(db.conn(), id) else {
        return Response::text(404, "no such mission");
    };
    match file {
        Some(name) => run_file(ctx, &m, name),
        None => match mission_page(ctx, &db, &m) {
            Ok(r) => r,
            Err(e) => Response::text(500, &e),
        },
    }
}

fn runs_dir(ctx: &Ctx, m: &Mission) -> PathBuf {
    ctx.home.runs(&m.label())
}

/// `GET /m/<id>` (UI-9).
fn mission_page(ctx: &Ctx, db: &Db, m: &Mission) -> Result<Response, String> {
    let tick = Tick::now();
    let mut b = format!(
        "<h1>{} <span class=\"dim\">{}</span></h1><p>{} · {} · attempt {}{}</p>",
        esc(&m.label()),
        pages::repo_link(ctx, &m.repo),
        esc(m.kind.as_str()),
        esc(m.stage.as_str()),
        m.attempt,
        link(m.pr_url.as_deref(), " · PR")
    );
    if let Some(w) = &m.waiting {
        let _ = write!(b, "<p class=\"warn\">waiting: {}</p>", esc(w));
    }
    if let Some(w) = &m.why {
        let _ = write!(b, "<p class=\"dim\">{}</p>", esc(w));
    }
    let _ = write!(
        b,
        "<p>cost ${:.2} · agent time {}</p>",
        m.cost_usd,
        ago(tick.unix() - m.agent_secs, &tick)
    );
    let mut q = db
        .conn()
        .prepare("SELECT mission, at, from_stage, event, to_stage, why FROM transitions WHERE mission = ?1 ORDER BY id")
        .map_err(sql)?;
    let ts: Vec<Transition> = q
        .query_map([m.id], |r| {
            Ok(Transition {
                mission: r.get(0)?,
                at: r.get(1)?,
                from: r.get(2)?,
                event: r.get(3)?,
                to: r.get(4)?,
                why: r.get(5)?,
            })
        })
        .map_err(sql)?
        .collect::<Result<_, _>>()
        .map_err(sql)?;
    b.push_str("<h2>Moves</h2><table><tr><th>when</th><th>move</th><th>why</th></tr>");
    for t in &ts {
        let _ = write!(
            b,
            "<tr><td>{}</td><td>{} → {} <span class=\"dim\">({})</span></td><td>{}</td></tr>",
            esc(&when(t.at, &tick)),
            esc(&t.from),
            esc(&t.to),
            esc(&t.event),
            esc(t.why.as_deref().unwrap_or(""))
        );
    }
    b.push_str("</table><h2>Run files</h2><ul>");
    let mut files: Vec<(String, u64, f64)> = std::fs::read_dir(runs_dir(ctx, m))
        .map(|rd| {
            rd.filter_map(Result::ok)
                .filter_map(|e| {
                    let md = e.metadata().ok()?;
                    let name = e.file_name().to_string_lossy().into_owned();
                    (md.is_file() && name_ok(&name)).then(|| {
                        let t = md
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map_or(0.0, |d| d.as_secs_f64());
                        (name, md.len(), t)
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    files.sort_by(|a, b| b.2.total_cmp(&a.2));
    for (name, size, t) in &files {
        let _ = write!(
            b,
            "<li><a href=\"/m/{}/runs/{}\">{}</a> <span class=\"dim\">{} B · {}</span></li>",
            m.id,
            esc(name),
            esc(name),
            size,
            esc(&when(*t, &tick))
        );
    }
    if files.is_empty() {
        b.push_str("<li class=\"dim\">none yet</li>");
    }
    b.push_str("</ul>");
    Ok(page_shell(ctx, &m.label(), &b, true))
}

fn name_ok(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && !name.ends_with(".raw")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

/// `GET /m/<id>/runs/<name>` (UI-10): a regular text file directly in the mission's runs dir.
fn run_file(ctx: &Ctx, m: &Mission, name: &str) -> Response {
    let not_found = || Response::text(404, "not found");
    if !name_ok(name) {
        return not_found();
    }
    let dir = runs_dir(ctx, m);
    let path = dir.join(name);
    let Ok(md) = std::fs::symlink_metadata(&path) else {
        return not_found();
    };
    if !md.file_type().is_file() {
        return not_found();
    }
    match (
        path.parent().and_then(|p| p.canonicalize().ok()),
        dir.canonicalize().ok(),
    ) {
        (Some(a), Some(b)) if a == b => {}
        _ => return not_found(),
    }
    let Ok(bytes) = read_tail(&path, RUN_FILE_MAX) else {
        return not_found();
    };
    if bytes.contains(&0) {
        return not_found();
    }
    let text = redact(ctx, &String::from_utf8_lossy(&bytes));
    Response::new(200, "text/plain; charset=utf-8", text).with("Content-Security-Policy", "sandbox")
}

fn read_tail(path: &Path, max: u64) -> std::io::Result<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path)?;
    let len = f.metadata()?.len();
    if len > max {
        f.seek(SeekFrom::Start(len - max))?;
    }
    let mut out = Vec::new();
    f.take(max).read_to_end(&mut out)?;
    Ok(out)
}

/// The URL `towercab ui` prints.
pub fn url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/")
}
