//! Messages only when I must act (LOOP-14, loop.md **Messages**): `outbox` rows, written in
//! the transaction of what causes them.
//!
//! So far the rows and their text (loop-runner part 2); sending them over Telegram, dropping
//! stale ones and the other notices come with part 4.

use rusqlite::{Connection, params};

use crate::config::Config;
use crate::db::sql;
use crate::machine::Waiting;
use crate::repo::protect::github_repo;

/// Longest message (Telegram's limit is 4096).
pub const MAX: usize = 4000;
pub const TITLE_MAX: usize = 200;
pub const WHY_MAX: usize = 300;

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

/// The other messages (part 2: those `machine::apply` writes).
#[derive(Debug, Clone, PartialEq)]
pub enum Notice {
    RepoFrozen {
        repo: String,
        why: String,
    },
    RehearsalFailed {
        repo: String,
        why: String,
        pr_url: Option<String>,
    },
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

/// A notice's text.
pub fn render_notice(n: &Notice) -> String {
    let lines = match n {
        Notice::RepoFrozen { repo, why } => vec![
            format!("repo frozen: {repo}: trust {repo} when fixed"),
            cut(&one_line(why), WHY_MAX),
        ],
        Notice::RehearsalFailed { repo, why, pr_url } => {
            let mut l = vec![
                format!("rollback rehearsal failed: {repo}"),
                cut(&one_line(why), WHY_MAX),
            ];
            if let Some(pr) = pr_url {
                l.push(format!("PR {pr}"));
            }
            l
        }
    };
    finish(lines)
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
