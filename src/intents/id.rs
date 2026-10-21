//! Intent IDs and folder names (INT-3).

use std::collections::BTreeSet;
use std::sync::LazyLock;

use chrono::{DateTime, FixedOffset};
use regex::Regex;

static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\d{6})-(\d{4})(?:-(\d+))?$").unwrap());
static DIR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\d{6}-\d{4}(?:-\d+)?)-([a-z][a-z0-9-]*)$").unwrap());

/// Longest slug before the `n` prefix.
pub const SLUG_MAX: usize = 48;

/// `YYMMDD-HHMM` of `created`; a clash with `taken` gets `-2`, `-3`, … IDs are never reused:
/// `taken` holds every folder's ID in `intents/` and `done/` and every ID in `done/legacy.md`.
pub fn new_id(created: DateTime<FixedOffset>, taken: &BTreeSet<String>) -> String {
    let base = created.format("%y%m%d-%H%M").to_string();
    if !taken.contains(&base) {
        return base;
    }
    (2..)
        .map(|n| format!("{base}-{n}"))
        .find(|id| !taken.contains(id))
        .expect("an unused suffix")
}

/// True for `YYMMDD-HHMM` with an optional `-<n>`.
pub fn is_id(s: &str) -> bool {
    ID.is_match(s)
}

/// Sort key `(YYMMDD, HHMM, suffix)`, no suffix = 1; not an ID sorts last.
pub fn sort_key(id: &str) -> (u32, u32, u32) {
    match ID.captures(id) {
        Some(c) => (
            c[1].parse().unwrap_or(u32::MAX),
            c[2].parse().unwrap_or(u32::MAX),
            c.get(3)
                .map_or(1, |s| s.as_str().parse().unwrap_or(u32::MAX)),
        ),
        None => (u32::MAX, u32::MAX, u32::MAX),
    }
}

/// Slug from a title: lowercase ASCII `[a-z0-9-]`, at most 48 characters, `intent` if empty,
/// `n` in front of a leading digit.
pub fn slug(title: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in title.chars() {
        let c = c.to_ascii_lowercase();
        if c == '\'' || c == '\u{2019}' {
            continue;
        }
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if dash && !out.is_empty() {
                out.push('-');
            }
            dash = false;
            out.push(c);
        } else {
            dash = true;
        }
    }
    out.truncate(SLUG_MAX);
    let mut out = out.trim_matches('-').to_string();
    if out.is_empty() {
        out = "intent".into();
    }
    if out.starts_with(|c: char| c.is_ascii_digit()) {
        out.insert(0, 'n');
    }
    out
}

/// `<id>-<slug>` → `(id, slug)`; the ID part is greedy (`-2` belongs to the ID).
pub fn split_dir(name: &str) -> Option<(String, String)> {
    DIR.captures(name)
        .map(|c| (c[1].to_string(), c[2].to_string()))
}

/// An exact ID, else the single ID ending with `s`.
pub fn resolve<'a, I>(s: &str, ids: I) -> Result<String, String>
where
    I: IntoIterator<Item = &'a str>,
{
    let ids: BTreeSet<&str> = ids.into_iter().collect();
    if ids.contains(s) {
        return Ok(s.to_string());
    }
    let matches: Vec<&str> = if s.is_empty() {
        Vec::new()
    } else {
        ids.iter().copied().filter(|id| id.ends_with(s)).collect()
    };
    match matches.as_slice() {
        [] => Err(format!("no open intent matches {s}")),
        [one] => Ok(one.to_string()),
        many => Err(format!(
            "{s} matches {} intents: {}",
            many.len(),
            many.join(", ")
        )),
    }
}
