//! Usage limits (LOOP-9, loop.md **Limits**).
//!
//! So far what the machine's `Cool` needs: [`Limit`], [`backoff`], [`cool`], [`cooling`]
//! (loop-runner part 2). Detecting a limit and parsing its reset time come with part 3.

use std::time::Duration;

use chrono::{DateTime, Utc};
use rusqlite::{Connection, params};

use crate::db::{Cooldown, Db, sql};

/// The cooldowns' provider.
pub const CLAUDE: &str = "claude";

/// Seconds added to a parsed reset time.
pub const RESET_MARGIN: f64 = 30.0;

/// A run that hit a usage limit: its `--model`, the reset time if the text had one, the text.
#[derive(Debug, Clone, PartialEq)]
pub struct Limit {
    pub model: String,
    pub reset: Option<DateTime<Utc>>,
    pub text: String,
}

/// The n-th backoff without a reset time: min(2ⁿ⁻¹, 60) minutes.
pub fn backoff(n: u32) -> Duration {
    let mins = 1u64 << n.saturating_sub(1).min(6);
    Duration::from_secs(mins.min(60) * 60)
}

/// Upserts the `cooldowns` row of `(claude, limit.model)`: `until` = reset + 30 s, else now +
/// the next backoff (`backoffs + 1`). Returns `until`.
pub fn cool(conn: &Connection, limit: &Limit, now: f64) -> Result<f64, String> {
    let backoffs: i64 = conn
        .query_row(
            "SELECT backoffs FROM cooldowns WHERE provider = ?1 AND model = ?2",
            params![CLAUDE, limit.model],
            |r| r.get(0),
        )
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(0),
            e => Err(e),
        })
        .map_err(sql)?;
    let (until, parsed, backoffs) = match limit.reset {
        Some(t) => (
            t.timestamp_micros() as f64 / 1e6 + RESET_MARGIN,
            true,
            backoffs,
        ),
        None => (
            now + backoff(backoffs as u32 + 1).as_secs_f64(),
            false,
            backoffs + 1,
        ),
    };
    conn.execute(
        "INSERT INTO cooldowns (provider, model, until, parsed, backoffs, text, since)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (provider, model) DO UPDATE SET until = excluded.until,
           parsed = excluded.parsed, backoffs = excluded.backoffs, text = excluded.text",
        params![
            CLAUDE,
            limit.model,
            until,
            parsed,
            backoffs,
            limit.text,
            now
        ],
    )
    .map_err(sql)?;
    Ok(until)
}

/// Cooldowns still running at `now`.
pub fn cooling(db: &Db, now: f64) -> Result<Vec<Cooldown>, String> {
    let mut q = db
        .conn()
        .prepare("SELECT * FROM cooldowns WHERE until > ?1 ORDER BY model")
        .map_err(sql)?;
    q.query_map([now], Cooldown::from_row)
        .map_err(sql)?
        .collect::<Result<_, _>>()
        .map_err(sql)
}
