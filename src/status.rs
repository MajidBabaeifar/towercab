//! `towercab status` and `next`, and their Telegram forms (LOOP-13, loop.md **Status**,
//! **Next**): read from SQLite and the intents, so they work without a running loop.

use chrono::{DateTime, FixedOffset, TimeZone};

use crate::config::Config;
use crate::db::{Cooldown, Db, FaultRow, RepoCap, sql};
use crate::env;
use crate::intents::{Intent, Listing};
use crate::limits;
use crate::machine::{self, Stage, Waiting};
use crate::mission::{self, Mission};
use crate::outbox;
use crate::pick::{self, Decision};
use crate::priority::{self, DEFAULT_SCORE, parked, priority};
use crate::review::shown;
use crate::runloop::{Tick, shown_time};

/// An intent (or a rehearsal) as a line shows it.
#[derive(Debug, Clone, PartialEq)]
pub struct Item {
    pub id: String,
    pub repo: String,
    pub title: String,
}

impl Item {
    fn of(i: &Intent) -> Item {
        Item {
            id: i.id.clone(),
            repo: i.repo().to_string(),
            title: i.title().to_string(),
        }
    }

    /// A mission's: its intent's title (open or done), else its label.
    fn mission(m: &Mission, listing: Option<&Listing>) -> Item {
        let i = m
            .intent
            .as_deref()
            .and_then(|id| listing.and_then(|l| l.open.iter().chain(&l.done).find(|i| i.id == id)));
        Item {
            id: m.label(),
            repo: m.repo.clone(),
            title: i.map_or_else(|| m.label(), |i| i.title().to_string()),
        }
    }

    /// `<id> <repo>: <title>`.
    pub fn line(&self) -> String {
        format!(
            "{} {}: {}",
            shown(&self.id),
            shown(&self.repo),
            shown(&self.title)
        )
    }
}

/// A child running.
#[derive(Debug, Clone, PartialEq)]
pub struct Active {
    pub item: Item,
    pub stage: Stage,
    /// A Claude run's model.
    pub model: Option<String>,
    pub since: f64,
}

/// Waiting on me, with the action (a Towercab wait's message line 1).
#[derive(Debug, Clone, PartialEq)]
pub struct OnMe {
    pub item: Item,
    pub action: String,
    pub pr_url: Option<String>,
}

/// Waiting on CI or a deploy.
#[derive(Debug, Clone, PartialEq)]
pub struct OnCi {
    pub item: Item,
    pub stage: Stage,
    pub since: f64,
}

/// What `status` shows.
#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    pub version: String,
    pub now: DateTime<FixedOffset>,
    /// The loop's pid.
    pub running: Option<u32>,
    pub paused: bool,
    /// The open faults while `env_blocked` (LOOP-10), else empty.
    pub env_blocked: Vec<FaultRow>,
    pub active: Vec<Active>,
    pub on_me: Vec<OnMe>,
    pub on_ci: Vec<OnCi>,
    pub cooling: Vec<Cooldown>,
    /// Repos capped at a3 or frozen.
    pub caps: Vec<RepoCap>,
    /// `drafts` keys at step `failed`.
    pub drafts_failed: Vec<String>,
    pub intents_error: Option<String>,
    pub next: Option<Item>,
    pub review_due: bool,
}

/// The stages that wait on CI or a deploy.
pub const ON_CI: [Stage; 5] = [
    Stage::Ci,
    Stage::Deploy,
    Stage::RevertCi,
    Stage::RevertDeploy,
    Stage::RehearseCi,
];

/// A wait's action: a Towercab `waiting:` → its message's line 1, any other (mine) as written.
fn action(waiting: &str, id: &str) -> String {
    Waiting::parse(waiting)
        .and_then(|w| outbox::first_line(&w, id))
        .unwrap_or_else(|| waiting.to_string())
}

/// When `m` entered its stage: its last transition there, else `updated`.
fn entered(db: &Db, m: &Mission) -> Result<f64, String> {
    let at: Option<f64> = db
        .conn()
        .query_row(
            "SELECT MAX(at) FROM transitions WHERE mission = ?1 AND to_stage = ?2",
            rusqlite::params![m.id, m.stage.as_str()],
            |r| r.get(0),
        )
        .map_err(sql)?;
    Ok(at.unwrap_or(m.updated))
}

impl Snapshot {
    /// Reads the database and `listing` (`None`, or `intents_error`: the store couldn't be
    /// read); `running` = the loop's pid; `built`: every stage has a handler (picks on).
    pub fn read(
        db: &Db,
        listing: Option<&Listing>,
        intents_error: Option<&str>,
        config: &Config,
        running: Option<u32>,
        built: bool,
        tick: Tick,
    ) -> Result<Snapshot, String> {
        let conn = db.conn();
        let now = tick.unix();
        let missions = mission::unfinished(conn)?;
        let active = missions
            .iter()
            .filter(|m| m.has_child())
            .map(|m| Active {
                item: Item::mission(m, listing),
                stage: m.stage,
                model: m.child_model.clone(),
                since: m.child_since.unwrap_or(m.updated),
            })
            .collect();
        let mut on_me: Vec<OnMe> = missions
            .iter()
            .filter(|m| m.stage.waits())
            .map(|m| OnMe {
                item: Item::mission(m, listing),
                action: action(m.waiting.as_deref().unwrap_or_default(), &m.label()),
                pr_url: m.pr_url.clone(),
            })
            .collect();
        if let Some(l) = listing {
            on_me.extend(
                l.open
                    .iter()
                    .filter(|i| !missions.iter().any(|m| m.intent.as_ref() == Some(&i.id)))
                    .filter_map(|i| {
                        Some(OnMe {
                            item: Item::of(i),
                            action: action(i.waiting()?, &i.id),
                            pr_url: i.pr().map(str::to_string),
                        })
                    }),
            );
        }
        let mut on_ci = Vec::new();
        for m in missions.iter().filter(|m| ON_CI.contains(&m.stage)) {
            on_ci.push(OnCi {
                item: Item::mission(m, listing),
                stage: m.stage,
                since: entered(db, m)?,
            });
        }
        let env_blocked = if env::blocked(conn)? {
            env::faults(conn)?
        } else {
            Vec::new()
        };
        let caps = {
            let mut q = conn
                .prepare("SELECT * FROM repo_caps WHERE capped = 1 OR frozen = 1 ORDER BY repo")
                .map_err(sql)?;
            q.query_map([], RepoCap::from_row)
                .map_err(sql)?
                .collect::<Result<_, _>>()
                .map_err(sql)?
        };
        let drafts_failed = {
            let mut q = conn
                .prepare("SELECT key FROM drafts WHERE step = 'failed' ORDER BY key")
                .map_err(sql)?;
            q.query_map([], |r| r.get(0))
                .map_err(sql)?
                .collect::<Result<_, _>>()
                .map_err(sql)?
        };
        let (next, review_due) = match listing {
            Some(l) => {
                let state = pick::state(db, config, built, tick)?;
                let next = pick::decide(l, &state)
                    .pick
                    .and_then(|id| l.open.iter().find(|i| i.id == id))
                    .map(Item::of);
                let due = priority::review_due(l, config.intents.cutoff, tick.wall).is_some();
                (next, due)
            }
            None => (None, false),
        };
        Ok(Snapshot {
            version: env!("CARGO_PKG_VERSION").to_string(),
            now: tick.wall,
            running,
            paused: machine::paused(conn)?,
            env_blocked,
            active,
            on_me,
            on_ci,
            cooling: limits::cooling(db, now)?,
            caps,
            drafts_failed,
            intents_error: intents_error.map(str::to_string),
            next,
            review_due,
        })
    }
}

/// loop.md **Status**; empty sections left out.
pub fn render(s: &Snapshot) -> String {
    let time = |at: f64| shown_time(at, s.now);
    let mut head = format!("towercab {} · ", s.version);
    match s.running {
        Some(pid) => head.push_str(&format!("running (pid {pid})")),
        None => head.push_str("not running"),
    }
    if s.paused {
        head.push_str(" · paused");
    }
    if !s.env_blocked.is_empty() {
        head.push_str(" · env blocked");
    }
    let mut out = vec![head];
    if s.active.is_empty() {
        out.push("active: none".into());
    }
    for a in &s.active {
        out.push(format!(
            "active: {} · {} · {} · since {}",
            a.item.line(),
            a.stage,
            a.model.as_deref().map_or("-".to_string(), shown),
            time(a.since)
        ));
    }
    if !s.on_me.is_empty() {
        out.push("waiting on you:".into());
        for w in &s.on_me {
            let pr = w
                .pr_url
                .as_deref()
                .map(|u| format!(" · {}", shown(u)))
                .unwrap_or_default();
            out.push(format!("- {} · {}{pr}", w.item.line(), shown(&w.action)));
        }
    }
    if !s.on_ci.is_empty() {
        out.push("waiting on CI or deploy:".into());
        for c in &s.on_ci {
            out.push(format!(
                "- {} · {} · since {}",
                c.item.line(),
                c.stage,
                time(c.since)
            ));
        }
    }
    for c in &s.cooling {
        let until = s
            .now
            .offset()
            .timestamp_micros((c.until * 1e6) as i64)
            .single()
            .map(|t| t.format("%Y-%m-%d %H:%M %:z").to_string())
            .unwrap_or_default();
        out.push(format!("cooling: {} until {until}", shown(&c.model)));
    }
    for f in &s.env_blocked {
        out.push(format!(
            "env blocked: {}: {} · since {}",
            shown(&f.kind),
            shown(&f.error),
            time(f.since)
        ));
    }
    let caps: Vec<String> = s
        .caps
        .iter()
        .flat_map(|c| {
            let r = shown(&c.repo);
            [
                c.capped.then(|| format!("{r} capped at a3")),
                c.frozen.then(|| format!("{r} frozen")),
            ]
        })
        .flatten()
        .collect();
    if !caps.is_empty() {
        out.push(format!("repos: {}", caps.join(", ")));
    }
    if !s.drafts_failed.is_empty() {
        let keys: Vec<String> = s.drafts_failed.iter().map(|k| shown(k)).collect();
        out.push(format!("drafts failed: {}", keys.join(", ")));
    }
    if let Some(e) = &s.intents_error {
        out.push(format!("intents: {}", shown(e)));
    }
    out.push(match &s.next {
        Some(i) => format!("next: {}", i.line()),
        None => "next: nothing runnable".into(),
    });
    if s.review_due {
        out.push("review due: towercab review".into());
    }
    out.join("\n")
}

/// loop.md **Next**: the intent `d` picks and why (priority, scores, parked), then each
/// skipped one with its reason.
pub fn next_text(d: &Decision, listing: &Listing, cutoff: u8) -> String {
    let find = |id: &str| listing.open.iter().find(|i| i.id == id);
    let mut out = vec![match d.pick.as_deref().and_then(find) {
        Some(i) => {
            let p = priority(i.u(), i.i());
            let mut line = format!(
                "next: {} · p{p} u{} i{}",
                Item::of(i).line(),
                i.u().unwrap_or(DEFAULT_SCORE),
                i.i().unwrap_or(DEFAULT_SCORE)
            );
            if let Some(a) = i.a() {
                line.push_str(&format!(" a{a}"));
            }
            if parked(p, cutoff) {
                line.push_str(" · parked");
            }
            line
        }
        None => "next: nothing runnable".into(),
    }];
    if !d.skipped.is_empty() {
        out.push("skipped:".into());
        for (id, skip) in &d.skipped {
            let item = find(id).map_or_else(|| shown(id), |i| Item::of(i).line());
            out.push(format!("- {item} · {}", shown(&skip.to_string())));
        }
    }
    out.join("\n")
}
