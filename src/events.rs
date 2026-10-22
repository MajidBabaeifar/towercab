//! PR and intent events in every stage (LOOP-18). Level-triggered: each read re-derives at
//! most one event from the PR (against `missions.head` and `feedback_seen`) or the intent.

use chrono::DateTime;
use serde_json::Value;

use crate::github::{GhError, Identity};
use crate::intents::Listing;
use crate::machine::Event;
use crate::mission::{ENTER, Mission};

/// A comment or review on a PR.
#[derive(Debug, Clone, PartialEq)]
pub struct Comment {
    pub author: String,
    /// RFC 3339.
    pub at: String,
    pub body: String,
}

/// What a PR read gives (PIP-21).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PrState {
    /// `OPEN`, `CLOSED` or `MERGED`.
    pub state: String,
    pub merged_at: Option<String>,
    pub merge_commit: Option<String>,
    pub head: String,
    /// `MERGEABLE`, `CONFLICTING` or `UNKNOWN`.
    pub mergeable: String,
    /// Comments, reviews and review comments.
    pub comments: Vec<Comment>,
}

/// Where PR reads come from (`gh`; tests use a fake).
pub trait PrSource {
    fn read(&mut self, github: &str, pr: u64) -> Result<PrState, GhError>;
}

/// `gh pr view <n> -R <github> --json state,mergedAt,mergeCommit,headRefOid,mergeable,comments,reviews`
/// and `gh api --paginate --slurp repos/<github>/pulls/<n>/comments?per_page=100`, as
/// `identity` (its `gh`; LOOP-19).
pub struct GhPrs {
    pub identity: Identity,
}

fn s(v: &Value, k: &str) -> String {
    v.get(k)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn comments(items: Option<&Value>, author: &str, at: &str) -> Vec<Comment> {
    items
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|c| Comment {
                    author: match c.get(author) {
                        Some(Value::Object(o)) => o
                            .get("login")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        _ => String::new(),
                    },
                    at: s(c, at),
                    body: s(c, "body"),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `gh pr view`'s JSON and the review comments' → a [`PrState`].
pub fn parse_pr(view: &str, review_comments: &str) -> Result<PrState, String> {
    let v: Value = serde_json::from_str(view).map_err(|e| format!("gh pr view: {e}"))?;
    let mut all = comments(v.get("comments"), "author", "createdAt");
    all.extend(comments(v.get("reviews"), "author", "submittedAt"));
    if !review_comments.trim().is_empty() {
        let rc: Value =
            serde_json::from_str(review_comments).map_err(|e| format!("gh api comments: {e}"))?;
        // `--paginate --slurp`: one array per page.
        let pages: Vec<Value> = match rc {
            Value::Array(a) if a.iter().all(Value::is_array) => a,
            one => vec![one],
        };
        for page in &pages {
            all.extend(comments(Some(page), "user", "created_at"));
        }
    }
    Ok(PrState {
        state: s(&v, "state"),
        merged_at: v
            .get("mergedAt")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
            .map(str::to_string),
        merge_commit: v
            .get("mergeCommit")
            .and_then(|c| c.get("oid"))
            .and_then(Value::as_str)
            .map(str::to_string),
        head: s(&v, "headRefOid"),
        mergeable: s(&v, "mergeable"),
        comments: all,
    })
}

impl PrSource for GhPrs {
    fn read(&mut self, github: &str, pr: u64) -> Result<PrState, GhError> {
        let n = pr.to_string();
        let view = self.identity.gh(
            github,
            &[
                "pr",
                "view",
                &n,
                "-R",
                github,
                "--json",
                "state,mergedAt,mergeCommit,headRefOid,mergeable,comments,reviews",
            ],
        )?;
        let rc = self.identity.gh(
            github,
            &[
                "api",
                "--paginate",
                "--slurp",
                &format!("repos/{github}/pulls/{n}/comments?per_page=100"),
            ],
        )?;
        parse_pr(&view, &rc).map_err(GhError::Failed)
    }
}

/// RFC 3339 `a` later than `b` (unparseable: compared as text).
fn later(a: &str, b: &str) -> bool {
    match (
        DateTime::parse_from_rfc3339(a),
        DateTime::parse_from_rfc3339(b),
    ) {
        (Ok(a), Ok(b)) => a > b,
        _ => a > b,
    }
}

/// My comments newer than `feedback_seen` (all of mine when it is unset); one without text (an
/// approval on GitHub) says nothing to change.
pub fn new_feedback<'a>(m: &Mission, pr: &'a PrState, me: &str) -> Vec<&'a Comment> {
    pr.comments
        .iter()
        .filter(|c| c.author.eq_ignore_ascii_case(me) && !c.body.trim().is_empty())
        .filter(|c| {
            m.feedback_seen
                .as_deref()
                .is_none_or(|seen| later(&c.at, seen))
        })
        .collect()
}

/// At most one event from a PR read: `pr_merged` > `pr_closed` > `feedback` (mine, newer than
/// `feedback_seen`) > `conflict` (`CONFLICTING`; not once `sync_rounds` is at its cap of 3:
/// the PR waits on me, PIP-21) > `head_moved` (head ≠ `missions.head`).
pub fn pr_events(m: &Mission, pr: &PrState, me: &str) -> Option<Event> {
    if pr.state == "MERGED" || pr.merged_at.is_some() {
        return Some(Event::PrMerged);
    }
    if pr.state == "CLOSED" {
        return Some(Event::PrClosed);
    }
    if !new_feedback(m, pr, me).is_empty() {
        return Some(Event::Feedback);
    }
    if pr.mergeable == "CONFLICTING" && m.sync_rounds < 3 {
        return Some(Event::Conflict);
    }
    if let Some(head) = &m.head
        && !pr.head.is_empty()
        && pr.head != *head
    {
        return Some(Event::HeadMoved);
    }
    None
}

/// At most one event from an `intents` pull: intent file gone → `intent_removed` (an
/// unreadable one isn't gone); `retry: fresh` → `retry_fresh`; waiting on me with `waiting`
/// removed by me → `intent_continued`. None while `step = 'enter'` (the entry write is due).
pub fn intent_events(m: &Mission, listing: &Listing) -> Option<Event> {
    let id = m.intent.as_deref()?;
    if m.step == ENTER || m.stage.finished() {
        return None;
    }
    let Some(i) = listing.open.iter().find(|i| i.id == id) else {
        let unreadable = listing
            .unreadable
            .iter()
            .any(|u| u.id().as_deref() == Some(id));
        return (!unreadable).then_some(Event::IntentRemoved);
    };
    if i.retry() == Some("fresh") {
        return Some(Event::RetryFresh);
    }
    (m.stage.waits() && i.waiting().is_none()).then_some(Event::IntentContinued)
}
