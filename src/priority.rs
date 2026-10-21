//! Minimal priority (PRI-2..5): the order of the generated `TODO.md`.
//! The priority intent extends this (cutoff picks, review).

use std::cmp::Ordering;

use crate::intents::Intent;
use crate::intents::id::sort_key;

/// Missing `u` or `i` counts as 3 (PRI-2).
pub const DEFAULT_SCORE: u8 = 3;

/// `2*i + u` (PRI-3), missing scores counted as 3.
pub fn priority(u: Option<u8>, i: Option<u8>) -> u8 {
    2 * i.unwrap_or(DEFAULT_SCORE) + u.unwrap_or(DEFAULT_SCORE)
}

/// PRI-4: priority descending, then oldest ID first.
pub fn cmp(a: &Intent, b: &Intent) -> Ordering {
    priority(b.u(), b.i())
        .cmp(&priority(a.u(), a.i()))
        .then_with(|| sort_key(&a.id).cmp(&sort_key(&b.id)))
}

/// PRI-5: below the cutoff is parked.
pub fn parked(p: u8, cutoff: u8) -> bool {
    p < cutoff
}
