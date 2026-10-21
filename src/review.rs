//! `towercab review` (PRI-7, PRI-9): walk parked and stale intents; keep, rescore or drop each.
//!
//! Input and output are passed in (no TTY check), so tests and pipes drive it; end of input
//! is quit. Each answer is one `Store::update`, so a stopped walk keeps what was decided.

use std::io::{BufRead, Write};

use chrono::{DateTime, FixedOffset};

use crate::intents::store::rfc3339;
use crate::intents::views::one_line;
use crate::intents::{Intent, Stage, Store, StoreError, Value};
use crate::priority::{
    DEFAULT_SCORE, REVIEW_DAYS, Scores, parked, parse_scores, priority, queued, review_queue,
};

/// What a walk did; `left` = unanswered or refused.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Tally {
    pub kept: usize,
    pub rescored: usize,
    pub dropped: usize,
    pub left: usize,
}

/// One review answer: `f`, then `reviewed: <now>`, committed as `towercab: review <what> <id>`.
/// Refused when the intent is no longer queued (the loop may have picked it meanwhile).
fn answer(
    store: &Store,
    id: &str,
    what: &str,
    now: DateTime<FixedOffset>,
    mut f: impl FnMut(&mut Intent) -> Result<(), String>,
) -> Result<Intent, StoreError> {
    let reviewed = Value::Str(rfc3339(now));
    store.update(id, &format!("review {what}"), |i| {
        if !queued(i) {
            return Err(format!("{} is no longer queued", i.id));
        }
        f(i)?;
        i.set("reviewed", reviewed.clone())
    })
}

/// `k`: only `reviewed`.
pub fn keep(store: &Store, id: &str, now: DateTime<FixedOffset>) -> Result<Intent, StoreError> {
    answer(store, id, "keep", now, |_| Ok(()))
}

/// `r`: the scores given (checked again by `Intent::set`) + `reviewed`; the others stay.
pub fn rescore(
    store: &Store,
    id: &str,
    scores: Scores,
    now: DateTime<FixedOffset>,
) -> Result<Intent, StoreError> {
    answer(store, id, "rescore", now, |i| {
        for (key, score) in [("u", scores.u), ("i", scores.i), ("a", scores.a)] {
            if let Some(n) = score {
                i.set(key, Value::Int(n.into()))?;
            }
        }
        Ok(())
    })
}

/// `d` (PRI-9): `stage: dropped` + `reviewed`; the store adds `finished` and moves the folder
/// to `done/`. Never deleted.
pub fn drop(store: &Store, id: &str, now: DateTime<FixedOffset>) -> Result<Intent, StoreError> {
    answer(store, id, "drop", now, |i| {
        i.set("stage", Value::Str(Stage::Dropped.as_str().into()))
    })
}

fn say(out: &mut dyn Write, text: &str) -> Result<(), String> {
    out.write_all(text.as_bytes())
        .and_then(|()| out.flush())
        .map_err(|e| format!("review: {e}"))
}

/// Prints `prompt` (no newline) and reads one line, trimmed; `None` at end of input.
fn ask(
    input: &mut dyn BufRead,
    out: &mut dyn Write,
    prompt: &str,
) -> Result<Option<String>, String> {
    say(out, prompt)?;
    let mut line = String::new();
    match input.read_line(&mut line) {
        Ok(0) => Ok(None),
        Ok(_) => Ok(Some(line.trim().to_string())),
        Err(e) => Err(format!("review: {e}")),
    }
}

/// `u<u> i<i>[ a<a>]`, missing `u`/`i` shown as 3.
fn scores_of(i: &Intent) -> String {
    let mut s = format!(
        "u{} i{}",
        i.u().unwrap_or(DEFAULT_SCORE),
        i.i().unwrap_or(DEFAULT_SCORE)
    );
    if let Some(a) = i.a() {
        s.push_str(&format!(" a{a}"));
    }
    s
}

/// Asks for score words until they parse (at least one); `None` = quit.
fn ask_scores(
    input: &mut dyn BufRead,
    out: &mut dyn Write,
    intent: &Intent,
) -> Result<Option<Scores>, String> {
    let prompt = format!("scores (now {}): ", scores_of(intent));
    loop {
        let Some(line) = ask(input, out, &prompt)? else {
            return Ok(None);
        };
        if line.eq_ignore_ascii_case("q") {
            return Ok(None);
        }
        let words: Vec<&str> = line.split_whitespace().collect();
        if words.is_empty() {
            say(out, "want at least one of uN, iN, aN\n")?;
            continue;
        }
        match parse_scores(&words) {
            Ok(scores) => return Ok(Some(scores)),
            Err(e) => say(out, &format!("{e}\n"))?,
        }
    }
}

/// Walks the review queue (PRI-7, protocol in specs/priority.md **Review**). A refused answer
/// prints `not changed: <reason>` and goes on; a failed pull or push (`StoreError::Sync`) stops.
pub fn run(
    store: &Store,
    input: &mut dyn BufRead,
    out: &mut dyn Write,
    now: DateTime<FixedOffset>,
) -> Result<Tally, String> {
    let listing = store.list().map_err(|e| e.to_string())?;
    let cutoff = store.cutoff();
    let queue = review_queue(&listing, cutoff, now);
    let mut tally = Tally::default();
    if queue.is_empty() {
        say(out, "nothing to review\n")?;
        return Ok(tally);
    }
    let n = queue.len();
    say(
        out,
        &format!("{n} to review (parked, or not reviewed for {REVIEW_DAYS} days)\n"),
    )?;
    'walk: for (k, intent) in queue.iter().enumerate() {
        let p = priority(intent.u(), intent.i());
        let reviewed = intent.reviewed().map_or_else(
            || "never reviewed".to_string(),
            |t| format!("reviewed {}", t.format("%Y-%m-%d")),
        );
        say(
            out,
            &format!(
                "\n[{}/{n}] {} {}: {} · p{p} {} · {} · {reviewed}\n  {}/intent.md\n",
                k + 1,
                intent.id,
                one_line(intent.repo()),
                one_line(intent.title()),
                scores_of(intent),
                if parked(p, cutoff) { "parked" } else { "next" },
                one_line(&intent.dir),
            ),
        )?;
        let done = loop {
            let Some(a) = ask(input, out, "keep, rescore, drop or quit? [k/r/d/q] ")? else {
                break 'walk;
            };
            match a.to_ascii_lowercase().as_str() {
                "k" => {
                    break keep(store, &intent.id, now).map(|_| (&mut tally.kept, "kept".into()));
                }
                "r" => {
                    let Some(scores) = ask_scores(input, out, intent)? else {
                        break 'walk;
                    };
                    break rescore(store, &intent.id, scores, now).map(|new| {
                        let q = priority(new.u(), new.i());
                        let note = if parked(q, cutoff) { " (parked)" } else { "" };
                        (&mut tally.rescored, format!("rescored: p{p} → p{q}{note}"))
                    });
                }
                "d" => {
                    break drop(store, &intent.id, now)
                        .map(|new| (&mut tally.dropped, format!("dropped: {}", new.dir)));
                }
                "q" => break 'walk,
                _ => say(out, "want k, r, d or q\n")?,
            }
        };
        match done {
            Ok((count, msg)) => {
                *count += 1;
                say(out, &format!("{msg}\n"))?;
            }
            Err(StoreError::Refused(reason)) => {
                say(out, &format!("not changed: {}\n", one_line(&reason)))?;
            }
            Err(StoreError::Sync(reason)) => return Err(reason),
        }
    }
    tally.left = n - tally.kept - tally.rescored - tally.dropped;
    say(
        out,
        &format!(
            "\nkept {}, rescored {}, dropped {}, left {}\n",
            tally.kept, tally.rescored, tally.dropped, tally.left
        ),
    )?;
    Ok(tally)
}
