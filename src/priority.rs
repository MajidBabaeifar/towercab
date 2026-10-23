//! Priority, order, cutoff and the backlog review's queue ([PRI](../specs/priority.md)).
//! Computed on every read, never stored (PRI-6).

use std::cmp::Ordering;

use chrono::{DateTime, FixedOffset, NaiveDate, TimeDelta, TimeZone};

use crate::intents::id::sort_key;
use crate::intents::{Intent, Listing};

/// Missing `u` or `i` counts as 3 (PRI-2); never written.
pub const DEFAULT_SCORE: u8 = 3;

/// Days after which an intent is due for review again (PRI-7, PRI-8).
pub const REVIEW_DAYS: i64 = 30;

/// `2*i + u` (PRI-3, 3-15), missing scores counted as 3.
pub fn priority(u: Option<u8>, i: Option<u8>) -> u8 {
    2 * i.unwrap_or(DEFAULT_SCORE) + u.unwrap_or(DEFAULT_SCORE)
}

/// An intent's priority.
fn p(i: &Intent) -> u8 {
    priority(i.u(), i.i())
}

/// PRI-4: priority descending, then oldest ID first.
pub fn cmp(a: &Intent, b: &Intent) -> Ordering {
    p(b).cmp(&p(a))
        .then_with(|| sort_key(&a.id).cmp(&sort_key(&b.id)))
}

/// PRI-5: below the cutoff is parked.
pub fn parked(p: u8, cutoff: u8) -> bool {
    p < cutoff
}

/// Waiting to be picked: open (in `intents/`), no `stage`, no `waiting`.
pub fn queued(i: &Intent) -> bool {
    !i.dir.starts_with("done/") && i.stage().is_none() && i.waiting().is_none()
}

/// PRI-5, for the picker: queued intents whose `after` ids are all done (not dropped:
/// `Listing::done_ids`), PRI-4 order, `p >= cutoff` first, then parked ones. Skipping (frozen,
/// cooling, paused) is the loop's.
pub fn pick_order(listing: &Listing, cutoff: u8) -> Vec<&Intent> {
    let done = listing.done_ids();
    let mut runnable: Vec<&Intent> = listing
        .open
        .iter()
        .filter(|i| queued(i) && i.after().iter().all(|a| done.contains(a)))
        .collect();
    runnable.sort_by(|a, b| cmp(a, b));
    let (mut order, later): (Vec<&Intent>, Vec<&Intent>) =
        runnable.into_iter().partition(|i| !parked(p(i), cutoff));
    order.extend(later);
    order
}

/// At least `REVIEW_DAYS` before `now`.
fn stale(t: DateTime<FixedOffset>, now: DateTime<FixedOffset>) -> bool {
    now.signed_duration_since(t) >= TimeDelta::days(REVIEW_DAYS)
}

/// The time in an ID (`YYMMDD-HHMM`), read in `offset`.
pub fn id_time(id: &str, offset: FixedOffset) -> Option<DateTime<FixedOffset>> {
    let (ymd, hm, _) = sort_key(id);
    let naive = NaiveDate::from_ymd_opt(2000 + (ymd / 10000) as i32, ymd / 100 % 100, ymd % 100)?
        .and_hms_opt(hm / 100, hm % 100, 0)?;
    offset.from_local_datetime(&naive).single()
}

/// PRI-7: in the review queue: queued, `reviewed` missing or stale, and parked or stale
/// (`reviewed`, else `started`, else the ID's time in `now`'s offset). A `reviewed` or
/// `started` after `now` (a typo, a wrong clock) counts as missing.
fn to_review(i: &Intent, cutoff: u8, now: DateTime<FixedOffset>) -> bool {
    let reviewed = i.reviewed().filter(|t| *t <= now);
    let since = reviewed
        .or_else(|| i.started().filter(|t| *t <= now))
        .or_else(|| id_time(&i.id, *now.offset()));
    queued(i)
        && reviewed.is_none_or(|r| stale(r, now))
        && (parked(p(i), cutoff) || since.is_some_and(|t| stale(t, now)))
}

/// PRI-7: what `towercab review` walks, PRI-4 order.
pub fn review_queue(listing: &Listing, cutoff: u8, now: DateTime<FixedOffset>) -> Vec<&Intent> {
    let mut queue: Vec<&Intent> = listing
        .open
        .iter()
        .filter(|i| to_review(i, cutoff, now))
        .collect();
    queue.sort_by(|a, b| cmp(a, b));
    queue
}

/// The last backlog review: the newest `reviewed` over open and done intents, ignoring any
/// after `now` (one bad value would otherwise silence PRI-8 for good).
pub fn last_review(listing: &Listing, now: DateTime<FixedOffset>) -> Option<DateTime<FixedOffset>> {
    listing
        .open
        .iter()
        .chain(&listing.done)
        .filter_map(Intent::reviewed)
        .filter(|t| *t <= now)
        .max()
}

/// Why a backlog review is due (PRI-8).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReviewDue {
    /// No review for `REVIEW_DAYS` (or never: `last` is `None`).
    Monthly { last: Option<DateTime<FixedOffset>> },
    /// Every open intent is parked.
    NothingAtCutoff,
}

/// PRI-8: only with something to review; then monthly, else when nothing open is at or above
/// the cutoff. The message comes with the loop's outbox (LOOP-14).
pub fn review_due(listing: &Listing, cutoff: u8, now: DateTime<FixedOffset>) -> Option<ReviewDue> {
    if review_queue(listing, cutoff, now).is_empty() {
        return None;
    }
    let last = last_review(listing, now);
    if last.is_none_or(|t| stale(t, now)) {
        return Some(ReviewDue::Monthly { last });
    }
    let important = listing.open.iter().any(|i| !parked(p(i), cutoff));
    (!important).then_some(ReviewDue::NothingAtCutoff)
}

/// Score words given to `add` and the review's rescore.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Scores {
    pub u: Option<u8>,
    pub i: Option<u8>,
    pub a: Option<u8>,
}

/// PRI-1: `[uia][1-5]` words, each key at most once (none → all `None`).
pub fn parse_scores(words: &[impl AsRef<str>]) -> Result<Scores, String> {
    let mut scores = Scores::default();
    for s in words {
        let s = s.as_ref();
        let bad = || format!("bad score {s:?}: want uN, iN or aN with N 1-5, each once");
        let mut chars = s.chars();
        let (Some(k), Some(n), None) = (chars.next(), chars.next(), chars.next()) else {
            return Err(bad());
        };
        let n = n
            .to_digit(10)
            .filter(|n| (1..=5).contains(n))
            .ok_or_else(bad)? as u8;
        let slot = match k {
            'u' => &mut scores.u,
            'i' => &mut scores.i,
            'a' => &mut scores.a,
            _ => return Err(bad()),
        };
        if slot.replace(n).is_some() {
            return Err(bad());
        }
    }
    Ok(scores)
}
