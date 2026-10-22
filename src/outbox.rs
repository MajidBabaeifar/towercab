//! Messages only when I must act (LOOP-14, loop.md **Messages**): `outbox` rows keyed
//! (mission, event, n), written in the transaction of what causes them, sent oldest first by
//! [`send_due`] (Telegram, LOOP-16). A waiting row whose wait is over when due is dropped.

use chrono::{DateTime, FixedOffset};
use rusqlite::{Connection, params};

use crate::config::Config;
use crate::db::{Db, OutboxRow, sql};
use crate::env;
use crate::intents::Listing;
use crate::machine::Waiting;
use crate::mission;
use crate::priority::ReviewDue;
use crate::repo::protect::github_repo;

/// Longest message (Telegram's limit is 4096).
pub const MAX: usize = 4000;
pub const TITLE_MAX: usize = 200;
pub const WHY_MAX: usize = 300;

/// At most one review-due message per this many seconds (30 days, PRI-8).
pub const REVIEW_EVERY: f64 = 30.0 * 86_400.0;

/// What a message is about.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Subject {
    /// The intent id (a rehearsal: its repo).
    pub id: String,
    pub repo: String,
    pub title: String,
    /// The intent folder's slug (`<id>-<slug>`); empty → no intent link.
    pub slug: String,
    pub pr_url: Option<String>,
    pub why: Option<String>,
}

/// The messages that aren't a mission's wait (loop.md **Messages**, other messages).
#[derive(Debug, Clone, PartialEq)]
pub enum Notice {
    /// `revert failed` froze the repo (PIP-19).
    RepoFrozen { repo: String, why: String },
    /// LOOP-10: `kind` = the fault's kind, `fix` = `Fault::fix`.
    EnvBlocked {
        kind: String,
        error: String,
        fix: String,
    },
    /// PRI-8.
    ReviewDue(ReviewDue),
    /// PIP-35.
    RehearsalFailed {
        repo: String,
        why: String,
        pr_url: Option<String>,
    },
    /// MNT-6: a band at 3σ.
    Triage {
        band: String,
        value: f64,
        mean: f64,
        sigma: f64,
        pr_url: Option<String>,
    },
    /// PIP-33.
    EvalsDropped { points: f64, change: String },
    /// The answer to a Telegram message (LOOP-16).
    Reply(String),
}

impl Notice {
    /// The row's `mission` and `event`; `n` comes from the cause (since, episode, day, …).
    pub fn key(&self) -> (String, String) {
        match self {
            Notice::RepoFrozen { repo, .. } => (format!("repo:{repo}"), "frozen".into()),
            Notice::EnvBlocked { .. } => ("loop".into(), "env_blocked".into()),
            Notice::ReviewDue(_) => ("loop".into(), "review_due".into()),
            Notice::RehearsalFailed { repo, .. } => {
                (format!("repo:{repo}"), "rehearsal_failed".into())
            }
            Notice::Triage { band, .. } => ("loop".into(), format!("triage:{band}")),
            Notice::EvalsDropped { .. } => ("loop".into(), "evals_dropped".into()),
            Notice::Reply(_) => ("loop".into(), "reply".into()),
        }
    }
}

/// Control characters (newlines included) → one space each, trimmed.
pub fn one_line(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .trim()
        .to_string()
}

/// At most `max` characters, the last one `…` when cut.
pub fn cut(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// Line 1 of a waiting message (`None`: `PR closed` sends none).
pub fn first_line(w: &Waiting, id: &str) -> Option<String> {
    Some(match w {
        Waiting::PrClosed => return None,
        Waiting::ApproveSpec => format!("approve spec: approve {id}"),
        Waiting::AuthorizeRelease => format!("authorize release: release {id}"),
        Waiting::E2eRedAfterYourMerge(_) => format!(
            "{}: approve {id} to keep it, or retry --fresh {id} to fix forward",
            w.text()
        ),
        w => w.text(),
    })
}

/// The intent's link: on GitHub when `[intents].remote` is, else its path.
pub fn intent_link(s: &Subject, config: &Config) -> String {
    let path = format!("intents/{}-{}/intent.md", s.id, s.slug);
    match config.intents.remote.as_deref().and_then(github_repo) {
        Some(r) => format!("https://github.com/{r}/blob/main/{path}"),
        None => path,
    }
}

/// A waiting message: line 1, `<id> <repo>: <title>`, why, `PR <url>`, `intent <url>`; each
/// line `one_line`, empty ones left out, at most [`MAX`] characters. `PR closed` → empty.
pub fn render_waiting(w: &Waiting, s: &Subject, config: &Config) -> String {
    let Some(first) = first_line(w, &s.id) else {
        return String::new();
    };
    let mut lines = vec![
        first,
        format!(
            "{} {}: {}",
            s.id,
            s.repo,
            cut(&one_line(&s.title), TITLE_MAX)
        ),
    ];
    if let Some(why) = &s.why {
        lines.push(cut(&one_line(why), WHY_MAX));
    }
    if let Some(pr) = &s.pr_url {
        lines.push(format!("PR {pr}"));
    }
    if !s.slug.is_empty() {
        lines.push(format!("intent {}", intent_link(s, config)));
    }
    finish(lines)
}

/// A number as a message shows it: at most 2 decimals, trailing zeros dropped.
pub fn num(x: f64) -> String {
    let s = format!("{x:.2}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// A notice's text (loop.md **Messages**: line 1, line 2, …; a reply as it is, ≤ [`MAX`]).
pub fn render_notice(n: &Notice) -> String {
    let pr = |p: &Option<String>| p.as_ref().map(|p| format!("PR {p}"));
    let lines: Vec<Option<String>> = match n {
        Notice::RepoFrozen { repo, why } => vec![
            Some(format!("repo frozen: {repo}: trust {repo} when fixed")),
            Some(cut(&one_line(why), WHY_MAX)),
        ],
        Notice::EnvBlocked { kind, error, fix } => vec![
            Some(format!(
                "env blocked: {kind}: {}",
                cut(&one_line(error), WHY_MAX)
            )),
            Some(format!("fix: {fix}")),
        ],
        Notice::ReviewDue(due) => vec![
            Some("review the backlog: towercab review".into()),
            Some(match due {
                ReviewDue::Monthly { last: Some(t) } => {
                    format!("last review {}", t.format("%Y-%m-%d"))
                }
                ReviewDue::Monthly { last: None } => "never reviewed".into(),
                ReviewDue::NothingAtCutoff => "nothing at or above the cutoff".into(),
            }),
        ],
        Notice::RehearsalFailed { repo, why, pr_url } => vec![
            Some(format!("rollback rehearsal failed: {repo}")),
            Some(cut(&one_line(why), WHY_MAX)),
            pr(pr_url),
        ],
        Notice::Triage {
            band,
            value,
            mean,
            sigma,
            pr_url,
        } => vec![
            Some(format!("triage: {band} at 3σ")),
            Some(format!(
                "value {} · mean {} · σ {}",
                num(*value),
                num(*mean),
                num(*sigma)
            )),
            pr(pr_url),
        ],
        Notice::EvalsDropped { points, change } => vec![Some(format!(
            "evals dropped {} points: {}",
            num(*points),
            cut(&one_line(change), WHY_MAX)
        ))],
        Notice::Reply(text) => return cut(text.trim(), MAX),
    };
    finish(lines.into_iter().flatten().collect())
}

fn finish(lines: Vec<String>) -> String {
    let text = lines
        .iter()
        .map(|l| one_line(l))
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    cut(&text, MAX)
}

/// `INSERT OR IGNORE` of an `outbox` row keyed (mission, event, n); true when it is new.
pub fn enqueue(
    conn: &Connection,
    mission: &str,
    event: &str,
    n: &str,
    text: &str,
    now: f64,
) -> Result<bool, String> {
    conn.execute(
        "INSERT OR IGNORE INTO outbox (mission, event, n, text, created) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![mission, event, n, text, now],
    )
    .map(|n| n == 1)
    .map_err(sql)
}

/// [`enqueue`] of a notice under its [`Notice::key`] and `n`.
pub fn notify(conn: &Connection, notice: &Notice, n: &str, now: f64) -> Result<bool, String> {
    let (mission, event) = notice.key();
    enqueue(conn, &mission, &event, n, &render_notice(notice), now)
}

/// PRI-8's message when `due`, at most once per [`REVIEW_EVERY`] (since the last `review_due`
/// row): `loop`, `review_due`, `now`'s `YYYY-MM-DD`. True when written.
pub fn review_due(
    conn: &Connection,
    due: Option<ReviewDue>,
    now: DateTime<FixedOffset>,
) -> Result<bool, String> {
    let Some(due) = due else {
        return Ok(false);
    };
    let at = crate::runloop::unix(now);
    let last: Option<f64> = conn
        .query_row(
            "SELECT MAX(created) FROM outbox WHERE mission = 'loop' AND event = 'review_due'",
            [],
            |r| r.get(0),
        )
        .map_err(sql)?;
    if last.is_some_and(|t| at - t < REVIEW_EVERY) {
        return Ok(false);
    }
    let day = now.format("%Y-%m-%d").to_string();
    notify(conn, &Notice::ReviewDue(due), &day, at)
}

/// Where unsent messages go (Telegram; tests use fakes).
pub trait Sender {
    /// Sends one message; `Err` = not sent, retried later.
    fn send(&mut self, text: &str) -> Result<(), String>;
}

/// What a [`send_due`] did.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Sent {
    pub sent: usize,
    /// Waiting rows whose wait was over (`sent_at = 0`).
    pub dropped: usize,
    /// The failure that stopped it.
    pub failed: Option<String>,
}

/// A waiting row whose wait is over: its mission no longer waits for that reason, or does with
/// another `n` (`continued`, the PR head); an intent-level one (`intent:<id>`): the intent
/// isn't open, has an unfinished mission or another `waiting` (none yet: its write follows the
/// row, so it may still be due). Notices never are.
pub fn obsolete(
    conn: &Connection,
    row: &OutboxRow,
    listing: Option<&Listing>,
) -> Result<bool, String> {
    if let Ok(id) = row.mission.parse::<i64>() {
        let m = match mission::get(conn, id) {
            Ok(m) => m,
            Err(_) => return Ok(true),
        };
        let Some(w) = m.waiting() else {
            return Ok(true);
        };
        let n = if w == Waiting::ReviewAndMergePr {
            m.head.clone().unwrap_or_default()
        } else {
            m.continued.to_string()
        };
        return Ok(m.stage.finished() || w.key() != row.event || n != row.n);
    }
    let (Some(id), Some(listing)) = (row.mission.strip_prefix("intent:"), listing) else {
        return Ok(false);
    };
    let Some(i) = listing.open.iter().find(|i| i.id == id) else {
        return Ok(true);
    };
    if mission::unfinished_for(conn, id)?.is_some() {
        return Ok(true);
    }
    Ok(i.waiting()
        .is_some_and(|w| Waiting::parse(w).is_none_or(|w| w.key() != row.event)))
}

/// Unsent rows, oldest first: obsolete waiting rows dropped (`sent_at = 0`); the rest sent
/// until the first failure, or a row whose retry isn't due yet, which holds the ones after it.
/// Sent: `sent_at` = now; failed: `tries + 1`, `next_try` = now + the LOOP-10 backoff.
pub fn send_due(
    db: &Db,
    sender: &mut dyn Sender,
    listing: Option<&Listing>,
    now: f64,
) -> Result<Sent, String> {
    let conn = db.conn();
    let rows: Vec<OutboxRow> = {
        let mut q = conn
            .prepare("SELECT * FROM outbox WHERE sent_at IS NULL ORDER BY created, rowid")
            .map_err(sql)?;
        q.query_map([], OutboxRow::from_row)
            .map_err(sql)?
            .collect::<Result<_, _>>()
            .map_err(sql)?
    };
    let sent_at = |row: &OutboxRow, at: f64| {
        conn.execute(
            "UPDATE outbox SET sent_at = ?1 WHERE mission = ?2 AND event = ?3 AND n = ?4",
            params![at, row.mission, row.event, row.n],
        )
        .map(drop)
        .map_err(sql)
    };
    let mut out = Sent::default();
    for row in rows {
        if obsolete(conn, &row, listing)? {
            sent_at(&row, 0.0)?;
            out.dropped += 1;
            continue;
        }
        if row.next_try > now {
            break;
        }
        match sender.send(&row.text) {
            Ok(()) => {
                sent_at(&row, now)?;
                out.sent += 1;
            }
            Err(e) => {
                let tries = row.tries + 1;
                let next = now + env::backoff(tries as u32).as_secs_f64();
                conn.execute(
                    "UPDATE outbox SET tries = ?1, next_try = ?2 WHERE mission = ?3 AND event = ?4 AND n = ?5",
                    params![tries, next, row.mission, row.event, row.n],
                )
                .map_err(sql)?;
                out.failed = Some(e);
                break;
            }
        }
    }
    Ok(out)
}
