//! Usage limits (LOOP-9, loop.md **Limits**): detecting one in a failed run, parsing when it
//! lifts, and the per (provider, model) cooldowns the machine's `Cool` writes.

use std::sync::LazyLock;
use std::time::Duration;

use chrono::{
    DateTime, Datelike, FixedOffset, LocalResult, NaiveDate, NaiveDateTime, NaiveTime, TimeDelta,
    TimeZone, Utc,
};
use chrono_tz::Tz;
use regex::Regex;
use rusqlite::{Connection, OptionalExtension, params};

use crate::db::{Cooldown, Db, sql};
use crate::outbox::{cut, one_line};

/// The cooldowns' provider.
pub const CLAUDE: &str = "claude";

/// Seconds added to a parsed reset time.
pub const RESET_MARGIN: f64 = 30.0;

/// Longest `Limit::text` (and `cooldowns.text`).
pub const TEXT_MAX: usize = 300;

/// A run that hit a usage limit: its `--model`, the reset time if the text had one, the text.
#[derive(Debug, Clone, PartialEq)]
pub struct Limit {
    pub model: String,
    pub reset: Option<DateTime<Utc>>,
    pub text: String,
}

static DETECT: LazyLock<regex::bytes::Regex> = LazyLock::new(|| {
    regex::bytes::Regex::new(
        r"(?i-u)rate.?limit|usage.?limit|hit your limit|limit reached|limit will reset|quota|too many requests|\b429\b|overloaded|rate_limit_error|overloaded_error",
    )
    .expect("detect regex")
});

static EPOCH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\|([0-9]{10})\b").expect("epoch regex"));

static RETRY_AFTER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)retry[- ]after[\s:=]+([0-9]+)").expect("retry-after regex"));

const UNIT: &str = r"(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b";

static IN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?i)(?:try again|retry|resets?|available again) in ([0-9]+)\s*{UNIT}(?:\s+([0-9]+)\s*{UNIT})?"
    ))
    .expect("in regex")
});

static DATETIME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"([0-9]{4})-([0-9]{2})-([0-9]{2})[T ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.[0-9]+)?)?([Zz]|[+-][0-9]{2}:?[0-9]{2})?",
    )
    .expect("datetime regex")
});

static CLOCK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\bresets?\s+(?:at\s+|on\s+)?(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+([0-9]{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?([0-9]{1,2})(?::([0-9]{2}))?\s*(am|pm)?\b(?:\s*\(([^)]+)\))?",
    )
    .expect("clock regex")
});

const MONTHS: [&str; 12] = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];

/// The text says a usage limit was hit (ASCII case-insensitive, loop.md **Limits**).
pub fn detect(text: &str) -> bool {
    DETECT.is_match(text.as_bytes())
}

/// A failed run's limit: `failed` (`is_error` or a non-zero exit) and its result, else its
/// stderr, [`detect`]ed → the limit, reset time from that text, text one line ≤ 300 chars.
pub fn of_run(
    model: &str,
    failed: bool,
    result: &str,
    stderr: &str,
    now: DateTime<FixedOffset>,
) -> Option<Limit> {
    if !failed {
        return None;
    }
    let text = [result, stderr].into_iter().find(|t| detect(t))?;
    Some(Limit {
        model: model.to_string(),
        reset: parse_reset(text, now),
        text: cut(&one_line(text), TEXT_MAX),
    })
}

/// When the limit lifts, from the text; the first rule that matches wins (loop.md
/// **Limits**): epoch, retry-after, "in N unit", a date and time, a clock time. A text
/// without a zone is in `now`'s offset.
pub fn parse_reset(text: &str, now: DateTime<FixedOffset>) -> Option<DateTime<Utc>> {
    let utc = now.with_timezone(&Utc);
    if let Some(c) = EPOCH.captures(text) {
        return DateTime::from_timestamp(c[1].parse().ok()?, 0);
    }
    if let Some(c) = RETRY_AFTER.captures(text) {
        return utc.checked_add_signed(TimeDelta::try_seconds(c[1].parse().ok()?)?);
    }
    if let Some(c) = IN.captures(text) {
        let mut secs = span(&c[1], &c[2])?;
        if let (Some(n), Some(u)) = (c.get(3), c.get(4)) {
            secs = secs.checked_add(span(n.as_str(), u.as_str())?)?;
        }
        return utc.checked_add_signed(TimeDelta::try_seconds(secs)?);
    }
    if let Some(c) = DATETIME.captures(text) {
        let num = |i: usize| c.get(i).map_or(Some(0), |m| m.as_str().parse::<u32>().ok());
        let date = NaiveDate::from_ymd_opt(c[1].parse().ok()?, num(2)?, num(3)?)?;
        let at = date.and_hms_opt(num(4)?, num(5)?, num(6)?)?;
        let offset = match c.get(7).map(|m| m.as_str()) {
            None => *now.offset(),
            Some("Z" | "z") => FixedOffset::east_opt(0)?,
            Some(z) => {
                let digits: String = z[1..].chars().filter(|c| *c != ':').collect();
                let (h, m): (i32, i32) = (digits[..2].parse().ok()?, digits[2..].parse().ok()?);
                let secs = (h * 3600 + m * 60) * if z.starts_with('-') { -1 } else { 1 };
                FixedOffset::east_opt(secs)?
            }
        };
        return local(&offset, at);
    }
    CLOCK.captures_iter(text).find_map(|c| {
        let (mon, day) = (c.get(1), c.get(2));
        let (mins, ampm) = (c.get(4), c.get(5));
        if ampm.is_none() && mins.is_none() && mon.is_none() {
            return None; // a bare number is not a time
        }
        let h: u32 = c[3].parse().ok()?;
        let hour = match ampm.map(|m| m.as_str().to_ascii_lowercase()) {
            Some(ap) if (1..=12).contains(&h) => h % 12 + if ap == "pm" { 12 } else { 0 },
            Some(_) => return None,
            None if h <= 23 => h,
            None => return None,
        };
        let minute = mins.map_or(Some(0), |m| m.as_str().parse().ok())?;
        let time = NaiveTime::from_hms_opt(hour, minute, 0)?;
        let date = match (mon, day) {
            (Some(m), Some(d)) => {
                let m = m.as_str().to_ascii_lowercase();
                let month = MONTHS.iter().position(|x| *x == m)? as u32 + 1;
                Some((month, d.as_str().parse().ok()?))
            }
            _ => None,
        };
        let zone = c.get(6).map(|z| z.as_str().trim());
        match zone {
            Some(z) if z.eq_ignore_ascii_case("utc") => next_at(&Utc, utc, date, time),
            Some(z) => match z.parse::<Tz>() {
                Ok(tz) => next_at(&tz, utc, date, time),
                Err(_) => next_at(now.offset(), utc, date, time),
            },
            None => next_at(now.offset(), utc, date, time),
        }
    })
}

/// `n` of `unit` (s, m, h, d by its first letter) in seconds.
fn span(n: &str, unit: &str) -> Option<i64> {
    let n: i64 = n.parse().ok()?;
    let mult = match unit.as_bytes().first()?.to_ascii_lowercase() {
        b's' => 1,
        b'm' => 60,
        b'h' => 3600,
        b'd' => 86400,
        _ => return None,
    };
    n.checked_mul(mult)
}

/// `at` in `tz` (a time skipped by a DST change: an hour later).
fn local<Z: TimeZone>(tz: &Z, at: NaiveDateTime) -> Option<DateTime<Utc>> {
    let t = match tz.from_local_datetime(&at) {
        LocalResult::Single(t) | LocalResult::Ambiguous(t, _) => t,
        LocalResult::None => tz
            .from_local_datetime(&(at + TimeDelta::hours(1)))
            .earliest()?,
    };
    Some(t.with_timezone(&Utc))
}

/// The next `time` in `tz` after `now`: today, else tomorrow; with a date, this year, else
/// next year.
fn next_at<Z: TimeZone>(
    tz: &Z,
    now: DateTime<Utc>,
    date: Option<(u32, u32)>,
    time: NaiveTime,
) -> Option<DateTime<Utc>> {
    let today = now.with_timezone(tz).date_naive();
    match date {
        Some((month, day)) => {
            let at = |year| {
                NaiveDate::from_ymd_opt(year, month, day).and_then(|d| local(tz, d.and_time(time)))
            };
            match at(today.year()) {
                Some(t) if t > now => Some(t),
                _ => at(today.year() + 1),
            }
        }
        None => {
            let t = local(tz, today.and_time(time))?;
            if t > now {
                Some(t)
            } else {
                local(tz, today.succ_opt()?.and_time(time))
            }
        }
    }
}

/// The n-th backoff without a reset time: min(2ⁿ⁻¹, 60) minutes.
pub fn backoff(n: u32) -> Duration {
    let mins = 1u64 << n.saturating_sub(1).min(6);
    Duration::from_secs(mins.min(60) * 60)
}

/// Upserts the `cooldowns` row of `(claude, limit.model)`: `until` = reset + 30 s, else now +
/// the next backoff (`backoffs + 1`); a reset already past (a stale epoch, a log line's
/// timestamp) is none, so the run isn't retried every pass. `since` = now unless the row's
/// cooldown is still running. Returns `until`.
pub fn cool(conn: &Connection, limit: &Limit, now: f64) -> Result<f64, String> {
    let (backoffs, old_until): (i64, Option<f64>) = conn
        .query_row(
            "SELECT backoffs, until FROM cooldowns WHERE provider = ?1 AND model = ?2",
            params![CLAUDE, limit.model],
            |r| Ok((r.get(0)?, Some(r.get(1)?))),
        )
        .optional()
        .map_err(sql)?
        .unwrap_or((0, None));
    let reset = limit
        .reset
        .map(|t| t.timestamp_micros() as f64 / 1e6 + RESET_MARGIN)
        .filter(|u| *u > now);
    let (until, parsed, backoffs) = match reset {
        Some(u) => (u, true, backoffs),
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
           parsed = excluded.parsed, backoffs = excluded.backoffs, text = excluded.text,
           since = CASE WHEN cooldowns.until > excluded.since THEN cooldowns.since ELSE excluded.since END",
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
    crate::indicators::cooled(&limit.model, old_until, until, now);
    Ok(until)
}

/// A run on `model` that hit no limit: its backoffs start over (LOOP-9).
pub fn success(conn: &Connection, model: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE cooldowns SET backoffs = 0 WHERE provider = ?1 AND model = ?2 AND backoffs > 0",
        params![CLAUDE, model],
    )
    .map(drop)
    .map_err(sql)
}

/// When `model`'s cooldown ends (`None`: no row).
pub fn until(conn: &Connection, model: &str) -> Result<Option<f64>, String> {
    conn.query_row(
        "SELECT until FROM cooldowns WHERE provider = ?1 AND model = ?2",
        params![CLAUDE, model],
        |r| r.get(0),
    )
    .optional()
    .map_err(sql)
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
