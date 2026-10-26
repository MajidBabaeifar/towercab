//! Commands I give the loop (LOOP-15): the CLI and Telegram insert a `commands` row; the loop
//! applies it at its next pass and stores the reply in `result` (a Telegram one's reply also
//! goes to the outbox, keyed by its update). With no loop running the CLI applies it itself,
//! then runs the entry effects its transitions made due.

use std::time::{Duration, Instant};

use rusqlite::{Connection, OptionalExtension, params};

use crate::config::Config;
use crate::db::{CommandRow, Db, del_meta, set_meta, sql};
use crate::exes::Exes;
use crate::github::Identity;
use crate::handler::{Ctx, Outcome, Probe};
use crate::home::Home;
use crate::intents::store::find_open;
use crate::intents::{Intent, Listing, Stage as Playbook, Store, id};
use crate::machine::{self, Apply, Event, Kind, Next, Stage};
use crate::mission;
use crate::outbox::{self, Notice};
use crate::runloop::Tick;

#[derive(Debug, Clone, PartialEq)]
pub enum Cmd {
    Approve(String),
    RetryFresh(String),
    Release(String),
    Pause,
    Resume,
    Trust(String),
    /// My answer to a wait: written to the intent's `## Answers`, then as `approve`.
    Answer(String, String),
    /// Globs added to the intent's `unlock` (PIP-29), then as `approve` when it waits.
    Unlock(String, Vec<String>),
    /// The intent dropped (`stage: dropped`): its mission stops (`intent_removed`).
    Drop(String),
}

/// An answer's most characters.
pub const ANSWER_MAX: usize = 2000;

/// An unlock glob: relative, no `..`, at most 200 characters of `[A-Za-z0-9._/*?-]`.
pub fn glob_ok(g: &str) -> bool {
    !g.is_empty()
        && g.len() <= 200
        && !g.starts_with('/')
        && !g.split('/').any(|p| p == "..")
        && g.chars()
            .all(|c| c.is_ascii_alphanumeric() || "._/*?-".contains(c))
}

pub const PAUSED: &str = "paused: no picks; merges and reverts hold";
pub const RESUMED: &str = "resumed";
/// `queue`'s CLI reply when the loop didn't answer in time.
pub const QUEUED: &str = "queued: applied on the loop's next pass";

impl Cmd {
    /// `commands.name`.
    pub fn name(&self) -> &'static str {
        match self {
            Cmd::Approve(_) => "approve",
            Cmd::RetryFresh(_) => "retry_fresh",
            Cmd::Release(_) => "release",
            Cmd::Pause => "pause",
            Cmd::Resume => "resume",
            Cmd::Trust(_) => "trust",
            Cmd::Answer(..) => "answer",
            Cmd::Unlock(..) => "unlock",
            Cmd::Drop(_) => "drop",
        }
    }

    /// The command as I type it, which starts its error replies (`approve: …`).
    pub fn word(&self) -> &'static str {
        match self {
            Cmd::RetryFresh(_) => "retry",
            c => c.name(),
        }
    }

    /// `commands.arg`: the intent id or repo, else empty.
    pub fn arg(&self) -> &str {
        match self {
            Cmd::Approve(a)
            | Cmd::RetryFresh(a)
            | Cmd::Release(a)
            | Cmd::Trust(a)
            | Cmd::Answer(a, _)
            | Cmd::Unlock(a, _)
            | Cmd::Drop(a) => a,
            Cmd::Pause | Cmd::Resume => "",
        }
    }

    /// `commands.text`: an answer, or the unlock globs one per line.
    pub fn text(&self) -> String {
        match self {
            Cmd::Answer(_, t) => t.clone(),
            Cmd::Unlock(_, g) => g.join("\n"),
            _ => String::new(),
        }
    }

    pub fn from_row(row: &CommandRow) -> Result<Cmd, String> {
        let arg = row.arg.clone();
        Ok(match row.name.as_str() {
            "approve" => Cmd::Approve(arg),
            "retry_fresh" => Cmd::RetryFresh(arg),
            "release" => Cmd::Release(arg),
            "pause" => Cmd::Pause,
            "resume" => Cmd::Resume,
            "trust" => Cmd::Trust(arg),
            "answer" => Cmd::Answer(arg, row.text.clone()),
            "unlock" => Cmd::Unlock(arg, row.text.lines().map(str::to_string).collect()),
            "drop" => Cmd::Drop(arg),
            other => return Err(format!("commands {}: unknown name {other:?}", row.id)),
        })
    }

    /// The reply is an error: `<word>: <reason>`.
    pub fn failed(&self, reply: &str) -> bool {
        reply
            .strip_prefix(self.word())
            .is_some_and(|r| r.starts_with(": "))
    }
}

/// Inserts a `commands` row from `source` (`cli` or `telegram`, with its `update_id`); returns
/// its id. Inside a transaction too (Telegram's, with `meta.tg_offset`).
pub fn insert(
    conn: &Connection,
    cmd: &Cmd,
    source: &str,
    update_id: Option<i64>,
    now: f64,
) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO commands (name, arg, text, source, update_id, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![cmd.name(), cmd.arg(), cmd.text(), source, update_id, now],
    )
    .map_err(sql)?;
    Ok(conn.last_insert_rowid())
}

/// [`insert`] now, without an update.
pub fn queue(db: &Db, cmd: &Cmd, source: &str) -> Result<i64, String> {
    insert(db.conn(), cmd, source, None, Tick::now().unix())
}

pub fn get(db: &Db, id: i64) -> Result<CommandRow, String> {
    db.conn()
        .query_row(
            "SELECT * FROM commands WHERE id = ?1",
            [id],
            CommandRow::from_row,
        )
        .map_err(sql)
}

/// Rows not applied yet, oldest first.
pub fn pending(db: &Db) -> Result<Vec<CommandRow>, String> {
    let mut q = db
        .conn()
        .prepare("SELECT * FROM commands WHERE applied_at IS NULL ORDER BY id")
        .map_err(sql)?;
    q.query_map([], CommandRow::from_row)
        .map_err(sql)?
        .collect::<Result<_, _>>()
        .map_err(sql)
}

/// What applying a command needs.
pub struct CmdCx<'a> {
    pub config: &'a Config,
    pub db: &'a Db,
    pub tick: Tick,
    /// The intent store: an intent-level `approve` and a `retry --fresh` without a mission
    /// write through it. `None`: they reply an error.
    pub store: Option<&'a Store>,
    /// The last `intents` listing: ids resolve against it (INT-3).
    pub listing: Option<&'a Listing>,
}

/// What a command does, decided before its transaction (an intent write is a git push).
enum Plan {
    /// Done (or refused): the reply.
    Reply(String),
    /// An event on the intent's unfinished mission, decided again inside the transaction.
    Mission {
        id: i64,
        intent: String,
    },
    Pause,
    Resume,
    Trust(String),
}

/// The stored reply of an applied row.
fn applied(conn: &Connection, id: i64) -> Result<Option<String>, String> {
    let done: Option<Option<String>> = conn
        .query_row(
            "SELECT result FROM commands WHERE id = ?1 AND applied_at IS NOT NULL",
            [id],
            |r| r.get(0),
        )
        .optional()
        .map_err(sql)?;
    Ok(done.map(Option::unwrap_or_default))
}

/// The open intent `q` names (any unique suffix); for `retry` a done or dropped one says so.
fn resolve(cx: &CmdCx, cmd: &Cmd, q: &str) -> Result<Intent, String> {
    let listing = cx.listing.ok_or("intents can't be read")?;
    find_open(listing, q).map_err(|e| {
        if matches!(cmd, Cmd::RetryFresh(_))
            && let Ok(id) = id::resolve(q, listing.done.iter().map(|i| i.id.as_str()))
            && let Some(i) = listing.done.iter().find(|i| i.id == id)
        {
            let how = match i.stage() {
                Some(Playbook::Dropped) => "dropped",
                _ => "done",
            };
            return format!("{id} is {how}");
        }
        e.to_string()
    })
}

/// The trailer of a command's own intent write: `Towercab-Command: <row id> <created>`. A
/// re-apply after a crash between the write and its row's `applied_at` finds it and answers as
/// the first time.
pub const COMMAND_MARK: &str = "Towercab-Command:";

fn plan(cx: &CmdCx, cmd: &Cmd, row: &CommandRow) -> Result<Plan, String> {
    let word = cmd.word();
    let intent = match cmd {
        Cmd::Pause => return Ok(Plan::Pause),
        Cmd::Resume => return Ok(Plan::Resume),
        Cmd::Trust(repo) => return Ok(Plan::Trust(repo.clone())),
        Cmd::Approve(q)
        | Cmd::RetryFresh(q)
        | Cmd::Release(q)
        | Cmd::Answer(q, _)
        | Cmd::Unlock(q, _)
        | Cmd::Drop(q) => match resolve(cx, cmd, q) {
            Ok(i) => i,
            Err(e) => return Ok(Plan::Reply(format!("{word}: {e}"))),
        },
    };
    let id = intent.id.clone();
    let m = mission::unfinished_for(cx.db.conn(), &id)?;
    let on_mission = |m: &mission::Mission| Plan::Mission {
        id: m.id,
        intent: id.clone(),
    };
    let mark = format!("{COMMAND_MARK} {} {}", row.id, row.created);
    let written = || cx.store.is_some_and(|s| s.has_mark(&mark).unwrap_or(false));
    let write = |what: &str, f: &dyn Fn(&mut Intent) -> Result<(), String>| match cx.store {
        None => Err("intents can't be read".to_string()),
        Some(_) if written() => Ok(()),
        Some(s) => s
            .update_marked(&id, what, Some(&mark), f)
            .map(drop)
            .map_err(|e| e.to_string()),
    };
    Ok(match (cmd, m) {
        (Cmd::Approve(_), Some(m)) if m.stage.waits() => on_mission(&m),
        // An intent-level wait (LOOP-5) or one of mine: removed, as by hand (PIP-17).
        (Cmd::Approve(_), None) if intent.waiting().is_some() || written() => {
            match write("approve", &|i| i.remove("waiting")) {
                Ok(()) => Plan::Reply(format!("approved {id}")),
                Err(e) => Plan::Reply(format!("{word}: {e}")),
            }
        }
        (Cmd::Approve(_), _) => Plan::Reply(format!("{word}: {id} isn't waiting on you")),
        (Cmd::RetryFresh(_), Some(m)) => on_mission(&m),
        (Cmd::RetryFresh(_), None) => {
            let unstage = |i: &mut Intent| {
                for key in ["waiting", "stage", "retry"] {
                    i.remove(key)?;
                }
                Ok(())
            };
            match write("retry", &unstage) {
                Ok(()) => {
                    let last: Option<u32> = cx
                        .db
                        .conn()
                        .query_row(
                            "SELECT MAX(attempt) FROM missions WHERE intent = ?1",
                            [&id],
                            |r| r.get(0),
                        )
                        .map_err(sql)?;
                    let n = last.unwrap_or(0).max(intent.attempts().unwrap_or(0)) + 1;
                    Plan::Reply(format!("fresh attempt {n} for {id}"))
                }
                Err(e) => Plan::Reply(format!("{word}: {e}")),
            }
        }
        (Cmd::Release(_), Some(m)) if m.stage == Stage::ApprovalRelease => on_mission(&m),
        (Cmd::Release(_), _) => Plan::Reply(format!("{word}: {id} isn't waiting for release")),
        (Cmd::Answer(_, text), m) => {
            let text = text.trim();
            if text.is_empty() || text.chars().count() > ANSWER_MAX {
                return Ok(Plan::Reply(format!(
                    "{word}: an answer is 1-{ANSWER_MAX} characters"
                )));
            }
            let waits = m.as_ref().is_some_and(|m| m.stage.waits());
            // A mission still running takes it too: the worker reads `intent.md` next time.
            if m.is_none() && intent.waiting().is_none() && !written() {
                return Ok(Plan::Reply(format!("{word}: {id} isn't waiting on you")));
            }
            let at = cx.tick.wall.format("%Y-%m-%d %H:%M").to_string();
            let add = |i: &mut Intent| {
                let mut s = i
                    .section("Answers")
                    .unwrap_or_default()
                    .trim_end()
                    .to_string();
                if !s.is_empty() {
                    s.push('\n');
                }
                s.push_str(&format!("- {at}: {}", crate::outbox::one_line(text)));
                i.set_section("Answers", &s)?;
                if m.is_none() {
                    i.remove("waiting")?;
                }
                Ok(())
            };
            match (write("answer", &add), m) {
                (Err(e), _) => Plan::Reply(format!("{word}: {e}")),
                (Ok(()), Some(m)) if waits => on_mission(&m),
                (Ok(()), Some(_)) => {
                    Plan::Reply(format!("noted for {id}: the worker reads it in intent.md"))
                }
                (Ok(()), None) => Plan::Reply(format!("answered {id}")),
            }
        }
        (Cmd::Unlock(_, globs), m) => {
            if globs.is_empty() || globs.len() > 20 || !globs.iter().all(|g| glob_ok(g)) {
                return Ok(Plan::Reply(format!(
                    "{word}: globs are relative paths (no `..`), 1-20 of them"
                )));
            }
            let add = |i: &mut Intent| {
                let mut all: Vec<String> = i.unlock().to_vec();
                for g in globs {
                    if !all.contains(g) {
                        all.push(g.clone());
                    }
                }
                i.set("unlock", crate::intents::Value::List(all))
            };
            match (write("unlock", &add), m) {
                (Err(e), _) => Plan::Reply(format!("{word}: {e}")),
                (Ok(()), Some(m)) if m.stage.waits() => on_mission(&m),
                (Ok(()), _) => Plan::Reply(format!("unlocked {} for {id}", globs.join(", "))),
            }
        }
        (Cmd::Drop(_), _) => {
            match write("drop", &|i| {
                i.set("stage", crate::intents::Value::Str("dropped".into()))
            }) {
                Ok(()) => Plan::Reply(format!("dropped {id}")),
                Err(e) => Plan::Reply(format!("{word}: {e}")),
            }
        }
        (Cmd::Pause | Cmd::Resume | Cmd::Trust(_), _) => unreachable!("planned above"),
    })
}

/// The event of a mission command, and its reply when the stage takes it.
fn on_mission(
    tx: &Connection,
    ax: &Apply,
    cmd: &Cmd,
    id: i64,
    intent: &str,
) -> Result<String, String> {
    let word = cmd.word();
    let cur = mission::get(tx, id)?;
    let (event, takes) = match cmd {
        Cmd::Approve(_) | Cmd::Answer(..) | Cmd::Unlock(..) => (Event::Approve, Next::Continue),
        Cmd::RetryFresh(_) => (Event::RetryFresh, Next::Fresh),
        Cmd::Release(_) => (Event::Release, Next::Go(Stage::Release)),
        _ => return Err(format!("{word} isn't a mission's command")),
    };
    if machine::next(cur.stage, event) != takes {
        return Ok(match cmd {
            Cmd::Approve(_) | Cmd::Answer(..) | Cmd::Unlock(..) => {
                format!("{word}: {intent} isn't waiting on you")
            }
            Cmd::Release(_) => format!("{word}: {intent} isn't waiting for release"),
            _ if cur.kind == Kind::Revert => format!("{word}: {intent} is reverting"),
            _ => format!("{word}: {intent} is at {}", cur.stage),
        });
    }
    // An answer is guidance for the worker: back to build even where `approve` goes on.
    let given = match (cmd, cur.waiting.as_deref()) {
        (Cmd::Answer(..), Some(w)) if w == machine::Waiting::TestsDontProve.text() => {
            Some(Next::Go(Stage::Build))
        }
        _ => None,
    };
    // My continue gives the loop's caps a fresh budget (conflict rounds, repairs): they stop
    // runaway loops without me, not the work I asked for.
    let mut o = Outcome::event(event);
    if event == Event::Approve {
        o = o
            .with("sync_rounds", 0i64)
            .with("verify_repairs", 0i64)
            .with("ci_repairs", 0i64);
    }
    machine::apply_tx(tx, ax, &cur, &o, given)?;
    Ok(match cmd {
        Cmd::Approve(_) => format!("approved {intent}"),
        Cmd::Answer(..) => format!("answered {intent}: continuing"),
        Cmd::Unlock(_, g) => format!("unlocked {} for {intent}: continuing", g.join(", ")),
        Cmd::Release(_) => format!("releasing {intent}"),
        _ => {
            let fresh = mission::unfinished_for(tx, intent)?
                .ok_or_else(|| format!("{intent}: no fresh attempt"))?;
            format!("fresh attempt {} for {intent}", fresh.attempt)
        }
    })
}

/// Applies `row` once: its effect, `applied_at` and `result` in one transaction (an intent
/// write it needs comes first); a Telegram row's reply goes to the outbox in it too. An
/// applied row returns its stored reply.
pub fn apply(cx: &CmdCx, row: &CommandRow) -> Result<String, String> {
    if let Some(reply) = applied(cx.db.conn(), row.id)? {
        return Ok(reply);
    }
    let cmd = Cmd::from_row(row)?;
    let plan = plan(cx, &cmd, row)?;
    let ax = Apply {
        db: cx.db,
        config: cx.config,
        listing: cx.listing,
        tick: cx.tick,
    };
    let now = cx.tick.unix();
    cx.db.tx(|tx| {
        if let Some(reply) = applied(tx, row.id)? {
            return Ok(reply);
        }
        let reply = match &plan {
            Plan::Reply(r) => r.clone(),
            Plan::Mission { id, intent } => on_mission(tx, &ax, &cmd, *id, intent)?,
            Plan::Pause => {
                set_meta(tx, "paused", "1")?;
                PAUSED.to_string()
            }
            Plan::Resume => {
                del_meta(tx, "paused")?;
                for m in mission::unfinished(tx)?.into_iter().filter(|m| m.held) {
                    machine::apply_tx(tx, &ax, &m, &Outcome::event(Event::Resume), None)?;
                }
                RESUMED.to_string()
            }
            Plan::Trust(repo) if !cx.config.repos.contains_key(repo) => {
                format!("trust: unknown repo {repo}")
            }
            Plan::Trust(repo) => {
                tx.execute("DELETE FROM repo_caps WHERE repo = ?1", [repo])
                    .map_err(sql)?;
                format!("trusted {repo}")
            }
        };
        tx.execute(
            "UPDATE commands SET applied_at = ?1, result = ?2 WHERE id = ?3",
            params![now, reply, row.id],
        )
        .map_err(sql)?;
        if let Some(update) = row.update_id {
            outbox::notify(tx, &Notice::Reply(reply.clone()), &update.to_string(), now)?;
        }
        Ok(reply)
    })
}

/// Applies every pending row, oldest first: (id, reply).
pub fn apply_pending(cx: &CmdCx) -> Result<Vec<(i64, String)>, String> {
    pending(cx.db)?
        .iter()
        .map(|row| Ok((row.id, apply(cx, row)?)))
        .collect()
}

/// Waits up to `timeout` for row `id`'s reply.
pub fn wait_result(db: &Db, id: i64, timeout: Duration) -> Option<String> {
    let end = Instant::now() + timeout;
    loop {
        if let Ok(row) = get(db, id)
            && row.applied_at.is_some()
        {
            return Some(row.result.unwrap_or_default());
        }
        if Instant::now() >= end {
            return None;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// The CLI's way (LOOP-15): queue `cmd`; the home's lock free → apply every pending row
/// (oldest first) against the pulled intents, run the entry effects now due, and return
/// `cmd`'s reply; else wait up to `wait` for the loop's reply (`None`: still queued).
pub fn submit(
    config: &Config,
    home: &Home,
    db: &Db,
    cmd: &Cmd,
    wait: Duration,
) -> Result<Option<String>, String> {
    let id = queue(db, cmd, "cli")?;
    match home.lock() {
        Ok(_lock) => {
            let store = Store::open(config).ok();
            let listing = store
                .as_ref()
                .map(|s| s.list().unwrap_or_else(|_| s.scan()));
            let tick = Tick::now();
            let cx = CmdCx {
                config,
                db,
                tick,
                store: store.as_ref(),
                listing: listing.as_ref(),
            };
            apply_pending(&cx)?;
            if let Some(store) = &store {
                enter_due(config, home, db, store, tick);
            }
            Ok(Some(get(db, id)?.result.unwrap_or_default()))
        }
        Err(e) if !e.starts_with("towercab is running ") => Err(e),
        Err(_) => Ok(wait_result(db, id, wait)),
    }
}

/// Entry effects due (LOOP-6) outside a loop; failures are logged, the next loop retries them.
fn enter_due(config: &Config, home: &Home, db: &Db, store: &Store, tick: Tick) {
    let exes = Exes::default();
    let mut identity = Identity::none();
    let probe = Probe::default();
    let Ok(entering) = mission::entering(db.conn()) else {
        return;
    };
    for m in entering {
        let mut cx = Ctx {
            config,
            home,
            db,
            store,
            exes: &exes,
            identity: &mut identity,
            tick,
            timeouts: true,
            probe: &probe,
        };
        if let Err(e) = machine::enter(&mut cx, &m) {
            crate::tlog!("towercab: {}: {e}", m.label());
        }
    }
}
