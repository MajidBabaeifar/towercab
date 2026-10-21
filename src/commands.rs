//! Commands I give the loop (LOOP-15): the CLI and Telegram insert a `commands` row; the loop
//! applies it at its next pass and stores the reply in `result`. With no loop running the CLI
//! applies it itself.
//!
//! So far `pause`, `resume` and `trust` act; `approve`, `retry --fresh` and `release` reply
//! `<command>: not built yet` until the state machine exists (loop-runner parts 2 and 4).

use std::time::{Duration, Instant};

use rusqlite::{OptionalExtension, params};

use crate::config::Config;
use crate::db::{CommandRow, Db, del_meta, set_meta, sql};
use crate::home::Home;
use crate::runloop::Tick;

#[derive(Debug, Clone, PartialEq)]
pub enum Cmd {
    Approve(String),
    RetryFresh(String),
    Release(String),
    Pause,
    Resume,
    Trust(String),
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
            Cmd::Approve(a) | Cmd::RetryFresh(a) | Cmd::Release(a) | Cmd::Trust(a) => a,
            Cmd::Pause | Cmd::Resume => "",
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

/// Inserts a `commands` row from `source` (`cli` or `telegram`); returns its id.
pub fn queue(db: &Db, cmd: &Cmd, source: &str) -> Result<i64, String> {
    db.conn()
        .execute(
            "INSERT INTO commands (name, arg, source, created) VALUES (?1, ?2, ?3, ?4)",
            params![cmd.name(), cmd.arg(), source, Tick::now().unix()],
        )
        .map_err(sql)?;
    Ok(db.conn().last_insert_rowid())
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
}

/// Applies `row` once: its effect, `applied_at` and `result` in one transaction. An applied
/// row returns its stored reply.
pub fn apply(cx: &CmdCx, row: &CommandRow) -> Result<String, String> {
    let cmd = Cmd::from_row(row)?;
    cx.db.tx(|tx| {
        let done: Option<Option<String>> = tx
            .query_row(
                "SELECT result FROM commands WHERE id = ?1 AND applied_at IS NOT NULL",
                [row.id],
                |r| r.get(0),
            )
            .optional()
            .map_err(sql)?;
        if let Some(result) = done {
            return Ok(result.unwrap_or_default());
        }
        let reply = match &cmd {
            Cmd::Pause => {
                set_meta(tx, "paused", "1")?;
                PAUSED.to_string()
            }
            Cmd::Resume => {
                del_meta(tx, "paused")?;
                RESUMED.to_string()
            }
            Cmd::Trust(repo) if !cx.config.repos.contains_key(repo) => {
                format!("trust: unknown repo {repo}")
            }
            Cmd::Trust(repo) => {
                tx.execute("DELETE FROM repo_caps WHERE repo = ?1", [repo])
                    .map_err(sql)?;
                format!("trusted {repo}")
            }
            Cmd::Approve(_) | Cmd::RetryFresh(_) | Cmd::Release(_) => {
                format!("{}: not built yet", cmd.word())
            }
        };
        tx.execute(
            "UPDATE commands SET applied_at = ?1, result = ?2 WHERE id = ?3",
            params![cx.tick.unix(), reply, row.id],
        )
        .map_err(sql)?;
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
/// (oldest first) and return `cmd`'s reply; else wait up to `wait` for the loop's reply
/// (`None`: still queued).
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
            let cx = CmdCx {
                config,
                db,
                tick: Tick::now(),
            };
            apply_pending(&cx)?;
            Ok(Some(get(db, id)?.result.unwrap_or_default()))
        }
        Err(e) if !e.starts_with("towercab is running ") => Err(e),
        Err(_) => Ok(wait_result(db, id, wait)),
    }
}
