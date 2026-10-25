//! The UI's other pages (UI-13..16): every intent, one intent, the repos; and intent edits.

use std::fmt::Write as _;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::wire::{Request, Response};
use super::{Ctx, ago, esc, link, page_shell, post_ok};
use crate::db::{Db, RepoCap, sql};
use crate::intents::edit::{self, Edit, MODELS};
use crate::intents::{Intent, store};
use crate::mission::{self, Mission};
use crate::priority;
use crate::runloop::Tick;

/// The repos panel's GitHub checks are kept this long.
pub const REPOS_CACHE: Duration = Duration::from_secs(300);

/// `https://github.com/<owner>/<name>` of a `[repos]` repo.
pub fn repo_url(ctx: &Ctx, repo: &str) -> Option<String> {
    let r = ctx.config.repos.get(repo)?.as_ref().ok()?;
    Some(format!("https://github.com/{}", r.github))
}

/// The repo name, linked to its GitHub page when it's in `[repos]`.
pub fn repo_link(ctx: &Ctx, repo: &str) -> String {
    match repo_url(ctx, repo) {
        Some(u) => link(Some(&u), repo),
        None => esc(repo),
    }
}

/// `intent.md` of `dir` on the `intents` remote's `main` (a `https://github.com/` remote).
pub fn intent_file_url(ctx: &Ctx, dir: &str) -> Option<String> {
    let remote = ctx.config.intents.remote.as_deref()?;
    let base = remote
        .strip_prefix("https://github.com/")?
        .trim_end_matches('/')
        .trim_end_matches(".git");
    Some(format!(
        "https://github.com/{base}/blob/main/{dir}/intent.md"
    ))
}

/// The intent's ID, linked to its file.
pub fn intent_link(ctx: &Ctx, i: &Intent) -> String {
    match intent_file_url(ctx, &i.dir) {
        Some(u) => link(Some(&u), &i.id),
        None => esc(&i.id),
    }
}

/// Where an intent stands for the list (UI-13).
fn state_of(i: &Intent, missions: &[Mission], cutoff: u8) -> String {
    if let Some(m) = missions.iter().find(|m| m.intent.as_ref() == Some(&i.id)) {
        return match &m.waiting {
            Some(w) => format!("waiting on you: {w}"),
            None => format!("running: {}", m.stage.as_str()),
        };
    }
    if let Some(w) = i.waiting() {
        return format!("waiting: {w}");
    }
    let p = priority::p(i);
    if priority::parked(p, cutoff) {
        "parked".into()
    } else {
        "queued".into()
    }
}

fn opt(n: Option<u8>) -> String {
    n.map_or_else(|| "–".into(), |n| n.to_string())
}

/// `<select>` of 1–5 (with "–" when `none`).
fn select(name: &str, cur: Option<u8>, none: bool) -> String {
    let mut s = format!("<select name=\"{name}\">");
    if none {
        let _ = write!(
            s,
            "<option value=\"\"{}>–</option>",
            if cur.is_none() { " selected" } else { "" }
        );
    }
    for v in 1..=5u8 {
        let sel = if cur == Some(v) || (!none && cur.is_none() && v == 3) {
            " selected"
        } else {
            ""
        };
        let _ = write!(s, "<option{sel}>{v}</option>");
    }
    s.push_str("</select>");
    s
}

fn model_select(cur: Option<&str>) -> String {
    let mut s = String::from("<select name=\"model\"><option value=\"\">default</option>");
    for m in MODELS {
        let sel = if cur == Some(m) { " selected" } else { "" };
        let _ = write!(s, "<option{sel}>{m}</option>");
    }
    s.push_str("</select>");
    s
}

/// The edit form of an open intent (UI-14).
fn edit_form(i: &Intent, can: bool) -> String {
    if !can {
        return String::new();
    }
    format!(
        "<form class=\"edit\" data-id=\"{id}\">u {u} i {ii} a {a} {model} \
         <button data-op=\"save\">Save</button> <button data-op=\"drop\" class=\"danger\">Drop</button></form>",
        id = esc(&i.id),
        u = select("u", i.u(), false),
        ii = select("i", i.i(), false),
        a = select("a", i.a(), true),
        model = model_select(i.model()),
    )
}

/// `GET /intents` (UI-13): every open intent in pick order, then the done ones.
pub fn intents_page(ctx: &Ctx) -> Result<Response, String> {
    let db = Db::open(&ctx.home.db())?;
    let listing = store::scan(&ctx.config.intents.path);
    let missions = mission::unfinished(db.conn())?;
    let cutoff = ctx.config.intents.cutoff;
    let can = ctx.can_act();
    let mut b = String::from("<h1>Intents</h1>");
    let _ = write!(
        b,
        "<p class=\"dim\">Pick order: priority 2i + u, oldest first. Below {cutoff} is parked: it waits until you raise u or i.</p>"
    );
    b.push_str("<table><tr><th>id</th><th>repo</th><th>title</th><th>p</th><th>u i a · model</th><th>state</th></tr>");
    for i in &listing.open {
        let p = priority::p(i);
        let _ = write!(
            b,
            "<tr><td>{}</td><td>{}</td><td><a href=\"/i/{}\">{}</a></td><td>{p}</td><td>{}</td><td>{}</td></tr>",
            intent_link(ctx, i),
            repo_link(ctx, i.repo()),
            esc(&i.id),
            esc(i.title()),
            if can {
                edit_form(i, true)
            } else {
                format!(
                    "{} {} {} · {}",
                    opt(i.u()),
                    opt(i.i()),
                    opt(i.a()),
                    esc(i.model().unwrap_or("default"))
                )
            },
            esc(&state_of(i, &missions, cutoff))
        );
    }
    b.push_str("</table>");
    if listing.open.is_empty() {
        b.push_str("<p class=\"dim\">No open intent.</p>");
    }
    if can {
        b.push_str(&add_form(ctx));
    }
    for u in &listing.unreadable {
        let _ = write!(
            b,
            "<p class=\"bad\">can't read {}: {}</p>",
            esc(&u.path),
            esc(&u.reason)
        );
    }
    b.push_str("<h2>Done</h2><table><tr><th>id</th><th>repo</th><th>title</th><th>PR</th><th>finished</th></tr>");
    for i in listing.done.iter().take(100) {
        let _ = write!(
            b,
            "<tr><td>{}</td><td>{}</td><td><a href=\"/i/{}\">{}</a> <span class=\"dim\">{}</span></td><td>{}</td><td>{}</td></tr>",
            intent_link(ctx, i),
            repo_link(ctx, i.repo()),
            esc(&i.id),
            esc(i.title()),
            esc(i.stage().map(|s| s.as_str()).unwrap_or("")),
            link(i.pr(), "PR"),
            esc(&i
                .finished()
                .map(|f| f.format("%Y-%m-%d").to_string())
                .unwrap_or_default())
        );
    }
    b.push_str("</table>");
    Ok(page_shell(ctx, "Intents · Towercab", &b, true))
}

fn add_form(ctx: &Ctx) -> String {
    let mut repos = String::from("<select name=\"repo\">");
    for name in ctx.config.repos.keys() {
        let _ = write!(repos, "<option>{}</option>", esc(name));
    }
    repos.push_str("</select>");
    format!(
        "<h2>Add an intent</h2><form class=\"add\">{repos} <input name=\"title\" placeholder=\"title\" size=\"40\" maxlength=\"200\"> \
         u {u} i {i} a {a} <button data-op=\"add\">Add</button></form>\
         <p class=\"dim\">A thin intent, as <code>towercab add</code>; fill in its problem and outcome in the file (or with <code>/intent</code> in Claude Code).</p>",
        u = select("u", None, false),
        i = select("i", None, false),
        a = select("a", None, true),
    )
}

/// `GET /i/<id>` (UI-15).
pub fn intent_page(ctx: &Ctx, id: &str) -> Result<Response, String> {
    let tick = Tick::now();
    let listing = store::scan(&ctx.config.intents.path);
    let Some(i) = listing
        .open
        .iter()
        .chain(&listing.done)
        .find(|i| i.id == id)
    else {
        return Ok(Response::text(404, "no such intent"));
    };
    let open = listing.open.iter().any(|o| o.id == i.id);
    let db = Db::open(&ctx.home.db())?;
    let missions = mission::for_intent(db.conn(), &i.id)?;
    let mut b = format!(
        "<h1>{} <span class=\"dim\">{}</span></h1><p>{} · {} · p{} (u {} i {} a {}) · model {}{}</p>",
        esc(i.title()),
        esc(&i.id),
        intent_link(ctx, i),
        repo_link(ctx, i.repo()),
        priority::p(i),
        opt(i.u()),
        opt(i.i()),
        opt(i.a()),
        esc(i.model().unwrap_or("default")),
        match i.pr() {
            Some(pr) => format!(" · {}", link(Some(pr), "PR")),
            None => String::new(),
        }
    );
    if let Some(u) = intent_file_url(ctx, &i.dir) {
        let plan = u.replace("/intent.md", "/plan.md");
        if std::path::Path::new(&ctx.config.intents.path)
            .join(&i.dir)
            .join("plan.md")
            .exists()
        {
            let _ = write!(b, "<p>{}</p>", link(Some(&plan), "plan.md"));
        }
    }
    if let Some(w) = i.waiting() {
        let _ = write!(b, "<p class=\"warn\">waiting: {}</p>", esc(w));
    }
    if open {
        b.push_str(&edit_form(i, ctx.can_act()));
    }
    for title in [
        "Problem",
        "Proposed outcome",
        "Affected users and systems",
        "Constraints",
        "Open questions",
        "Towercab",
    ] {
        if let Some(text) = i.section(title).filter(|t| !t.trim().is_empty()) {
            let _ = write!(
                b,
                "<h2>{}</h2><div class=\"md\">{}</div>",
                esc(title),
                md(&text)
            );
        }
    }
    b.push_str("<h2>Attempts</h2>");
    if missions.is_empty() {
        b.push_str("<p class=\"dim\">Not picked yet.</p>");
    } else {
        b.push_str("<table><tr><th>mission</th><th>attempt</th><th>stage</th><th>cost</th><th>updated</th></tr>");
        for m in &missions {
            let _ = write!(
                b,
                "<tr><td><a href=\"/m/{}\">{}</a></td><td>{}</td><td>{}</td><td>${:.2}</td><td>{} ago</td></tr>",
                m.id,
                esc(&m.label()),
                m.attempt,
                esc(m.stage.as_str()),
                m.cost_usd,
                ago(m.updated, &tick)
            );
        }
        b.push_str("</table>");
    }
    Ok(page_shell(ctx, &format!("{} · Towercab", i.id), &b, true))
}

/// Markdown-ish text: bullets become a list, the rest paragraphs; all escaped.
fn md(text: &str) -> String {
    let mut out = String::new();
    let mut in_list = false;
    for line in text.lines() {
        let t = line.trim();
        if let Some(item) = t.strip_prefix("- ") {
            if !in_list {
                out.push_str("<ul>");
                in_list = true;
            }
            let _ = write!(out, "<li>{}</li>", esc(item));
            continue;
        }
        if in_list && !line.starts_with("  ") {
            out.push_str("</ul>");
            in_list = false;
        }
        if !t.is_empty() {
            let _ = write!(out, "<p>{}</p>", esc(t));
        }
    }
    if in_list {
        out.push_str("</ul>");
    }
    out
}

/// One repo's readiness (UI-16).
struct RepoRow {
    name: String,
    github: String,
    base: String,
    clone: bool,
    checks: String,
    app: String,
    ruleset: String,
    cap: String,
}

fn repo_rows(ctx: &Ctx, db: &Db) -> Result<Vec<RepoRow>, String> {
    let caps: Vec<RepoCap> = {
        let mut q = db.conn().prepare("SELECT * FROM repo_caps").map_err(sql)?;
        q.query_map([], RepoCap::from_row)
            .map_err(sql)?
            .collect::<Result<_, _>>()
            .map_err(sql)?
    };
    let now = Tick::now().unix() as i64;
    let mut rows = Vec::new();
    for (name, repo) in &ctx.config.repos {
        let Ok(repo) = repo else {
            rows.push(RepoRow {
                name: name.clone(),
                github: String::new(),
                base: String::new(),
                clone: false,
                checks: "config error".into(),
                app: String::new(),
                ruleset: String::new(),
                cap: String::new(),
            });
            continue;
        };
        let clone = repo.path.join(".git").exists();
        let checks = if clone {
            match crate::repo::load(&repo.path, &repo.base) {
                Ok(f) => format!("ok: {} check line(s)", f.verifying.checks.len()),
                Err(e) => e.to_string(),
            }
        } else {
            "no clone yet (made at the first pick)".into()
        };
        let app = match ctx.identity.token(&repo.github, now) {
            Ok(_) => "installed".into(),
            Err(e) => e.to_string(),
        };
        let ruleset = match crate::repo::protect::find_ruleset(&ctx.exes.gh, &repo.github) {
            Ok(Some(_)) => "towercab ruleset".into(),
            Ok(None) => format!("none: towercab protect {name}"),
            Err(e) => e,
        };
        let cap = caps
            .iter()
            .find(|c| &c.repo == name)
            .map(|c| {
                if c.frozen {
                    format!("frozen: {} · trust {name}", c.why)
                } else {
                    format!("capped at a3: {} · trust {name}", c.why)
                }
            })
            .unwrap_or_default();
        rows.push(RepoRow {
            name: name.clone(),
            github: repo.github.clone(),
            base: repo.base.clone(),
            clone,
            checks,
            app,
            ruleset,
            cap,
        });
    }
    Ok(rows)
}

/// `GET /repos` (UI-16): GitHub checks cached [`REPOS_CACHE`]; `?fresh` reads again.
pub fn repos_page(ctx: &Ctx, fresh: bool) -> Result<Response, String> {
    let cached = ctx
        .repos_cache
        .lock()
        .ok()
        .and_then(|c| c.clone())
        .filter(|(at, _)| !fresh && at.elapsed() < REPOS_CACHE);
    let table = match cached {
        Some((_, t)) => t,
        None => {
            let db = Db::open(&ctx.home.db())?;
            let mut t = String::from(
                "<table><tr><th>repo</th><th>base</th><th>clone</th><th>CLAUDE.md checks</th><th>GitHub App</th><th>ruleset</th><th>cap</th></tr>",
            );
            for r in repo_rows(ctx, &db)? {
                let good = |s: &str| {
                    if s.starts_with("ok") || s == "installed" || s == "towercab ruleset" {
                        format!("<span class=\"ok\">{}</span>", esc(s))
                    } else {
                        format!("<span class=\"warn\">{}</span>", esc(s))
                    }
                };
                let gh = if r.github.is_empty() {
                    esc(&r.name)
                } else {
                    link(Some(&format!("https://github.com/{}", r.github)), &r.name)
                };
                let _ = write!(
                    t,
                    "<tr><td>{gh}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>",
                    esc(&r.base),
                    if r.clone { "yes" } else { "–" },
                    good(&r.checks),
                    good(&r.app),
                    good(&r.ruleset),
                    esc(&r.cap)
                );
            }
            t.push_str("</table>");
            if let Ok(mut c) = ctx.repos_cache.lock() {
                *c = Some((Instant::now(), t.clone()));
            }
            t
        }
    };
    let b = format!(
        "<h1>Repos</h1><p class=\"dim\">From <code>[repos]</code> in the config; GitHub checks kept 5 min · <a href=\"/repos?fresh\">check again</a></p>{table}"
    );
    Ok(page_shell(ctx, "Repos · Towercab", &b, true))
}

/// `POST /api/intent` (UI-14): `{op: save|drop|add, id, u, i, a, model, repo, title}` through
/// the intent writer; `{ok, reply}`.
pub fn intent_api(ctx: &Ctx, r: &Request) -> Response {
    if let Err(resp) = post_ok(ctx, r) {
        return resp;
    }
    if !ctx.can_act() {
        return Response::text(409, "towercab isn't running: towercab up");
    }
    let Ok(body) = serde_json::from_slice::<Value>(&r.body) else {
        return Response::text(400, "JSON body");
    };
    let s = |k: &str| {
        body.get(k)
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let score = |k: &str| -> Result<Option<u8>, Response> {
        match s(k).as_str() {
            "" => Ok(None),
            v => v
                .parse::<u8>()
                .ok()
                .filter(|n| (1..=5).contains(n))
                .map(Some)
                .ok_or_else(|| Response::text(400, &format!("{k} must be 1-5"))),
        }
    };
    let id_ok = |id: &str| {
        !id.is_empty()
            && id.len() <= 64
            && id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_".contains(c))
    };
    let result = match s("op").as_str() {
        "save" | "drop" => {
            let id = s("id");
            if !id_ok(&id) {
                return Response::text(400, "bad id");
            }
            let listing = store::scan(&ctx.config.intents.path);
            if !listing.open.iter().any(|i| i.id == id) {
                return Response::text(404, "no open intent with that id");
            }
            let edits = if s("op") == "drop" {
                if has_mission(ctx, &id) {
                    return Response::text(409, "it has a mission running: wait or retry --fresh");
                }
                vec![Edit::Drop]
            } else {
                let (u, i, a) = match (score("u"), score("i"), score("a")) {
                    (Ok(Some(u)), Ok(Some(i)), Ok(a)) => (u, i, a),
                    (Err(e), _, _) | (_, Err(e), _) | (_, _, Err(e)) => return e,
                    _ => return Response::text(400, "u and i are needed"),
                };
                let model = match s("model").as_str() {
                    "" => None,
                    m if MODELS.contains(&m) => Some(m.to_string()),
                    _ => return Response::text(400, "unknown model"),
                };
                vec![Edit::Scores { u, i, a }, Edit::Model(model)]
            };
            edits
                .iter()
                .map(|e| ctx.writer.edit(&id, e))
                .collect::<Result<Vec<_>, _>>()
                .map(|v| v.join(", "))
        }
        "add" => {
            let repo = s("repo");
            if !ctx.config.repos.contains_key(&repo) {
                return Response::text(400, "unknown repo");
            }
            let title = s("title");
            if title.is_empty() || title.chars().count() > 200 {
                return Response::text(400, "a title, at most 200 characters");
            }
            let (u, i, a) = match (score("u"), score("i"), score("a")) {
                (Ok(u), Ok(i), Ok(a)) => (u, i, a),
                (Err(e), _, _) | (_, Err(e), _) | (_, _, Err(e)) => return e,
            };
            ctx.writer
                .add(edit::new_intent(&repo, &title, u, i, a, Tick::now().wall))
                .map(|id| format!("added {id}"))
        }
        _ => return Response::text(400, "unknown op"),
    };
    match result {
        Ok(reply) => Response::json(&json!({"ok": true, "reply": reply})),
        Err(e) => Response::json(&json!({"ok": false, "reply": e})),
    }
}

fn has_mission(ctx: &Ctx, id: &str) -> bool {
    Db::open(&ctx.home.db())
        .ok()
        .and_then(|db| mission::unfinished(db.conn()).ok())
        .is_some_and(|ms| ms.iter().any(|m| m.intent.as_deref() == Some(id)))
}
