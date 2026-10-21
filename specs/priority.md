# Priority

**Status:** Live: PRI-1..9 · **Prefix:** PRI

## Purpose

Order intents by what matters, with arithmetic I can predict.

## Requirements

| ID | Requirement | Verified by |
|---|---|---|
| PRI-1 | Every intent has `u` (urgency), `i` (importance), integers 1–5; `a` (autonomy, 1–5) is optional. Enforced by `Intent::parse` and `Intent::set` (`<key> must be an integer 1-5`, [INT-2, INT-5](intents.md)) and by the score words of `add` and rescore (`priority::parse_scores`: `[uia][1-5]`, each key at most once, else `bad score "<s>": want uN, iN or aN with N 1-5, each once`). | test_scores_range |
| PRI-2 | Missing `u`, `i` default to 3 (`DEFAULT_SCORE`, applied on read, never written); missing `a` stays missing ([AUT-9](autonomy.md)). | test_defaults |
| PRI-3 | `priority = 2*i + u` (3–15): `priority::priority(u: Option<u8>, i: Option<u8>) -> u8`. | test_priority |
| PRI-4 | Order: priority desc, then ID asc (= oldest first; `id::sort_key`: `YYMMDD`, `HHMM`, suffix, none = 1): `priority::cmp(&Intent, &Intent) -> Ordering`. Computed by code, never by a model. | test_order |
| PRI-5 | `priority < cutoff` (`[intents].cutoff`, 1–15, default 7; `parked(p, cutoff)`) → parked: picked only when no intent at or above the cutoff is runnable ([LOOP-5](loop.md)). For the picker: `pick_order(&Listing, cutoff) -> Vec<&Intent>` = queued intents (`queued`: open, no `stage`, no `waiting`) whose `after` ids are all done (`Listing::done_ids`: in `done/legacy.md`, or in `done/` or `stage: done` and not `stage: dropped`), PRI-4 order, `p ≥ cutoff` first, then parked; skipping (frozen, cooling, paused) is the loop's. | test_cutoff, test_parked_after_important |
| PRI-6 | Order is computed on every read, never stored: the Next and Parked sections of the generated `TODO.md` show it ([INT-6](intents.md); `views::todo` sorts with `cmp`, `Listing::open` is in that order; no order or priority is written to `intent.md`). | test_todo_order |
| PRI-7 | `towercab review` (`review::run`, `src/review.rs`) walks parked intents and intents not reviewed for ≥ 30 days (`reviewed:` in `intent.md`, RFC 3339, [INT-5](intents.md)): keep, rescore, drop. Queue (`review_queue`): queued intents, PRI-4 order, `reviewed` missing or ≥ 30 days old, and parked or ≥ 30 days old (`reviewed`, else `started`, else the ID's time in `now`'s offset). Each answer is one `Store::update` (commit `towercab: review <keep\|rescore\|drop> <id>`) writing `reviewed: <now>`; an intent no longer queued is refused (`<id> is no longer queued`); new scores are checked twice (`parse_scores`, then `Intent::set`). Protocol: **Review**. | test_review_queue, test_review, test_rescore_validates |
| PRI-8 | Review due (`review_due(&Listing, cutoff, now) -> Option<ReviewDue>`, pure: the review queue not empty and the newest `reviewed` over open and done intents (`last_review`) missing or ≥ 30 days old → `Monthly { last }`, else no open intent with `p ≥ cutoff` → `NothingAtCutoff`) → one [LOOP-14](loop.md) message `review the backlog: towercab review`, at most once per 30 days; shown in `status`. The message, its 30-day limit and the `status` line come with the loop's outbox and `status` ([LOOP-13, 14](loop.md)). | test_review_trigger |
| PRI-9 | Dropping (`review::drop`, the review's `d`) sets `stage: dropped` (+ `reviewed`; the store adds `finished`) and moves the folder to `done/` (`Store::update`, `git mv`, [INT-1](intents.md)); intents are never deleted: `DONE.md` lists it `dropped`. | test_drop |

**Anchors**

| | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| u | someday | this quarter | this month | this week | now / blocking |
| i | nice to have | small gain | real value | core to a goal | goal depends on it |

`a`: see [autonomy.md](autonomy.md).

**Code** (all `pub`; `now: DateTime<FixedOffset>`; tests in `tests/priority.rs`, `tests/review.rs`)

| File | Interface |
|---|---|
| `src/priority.rs` | `DEFAULT_SCORE = 3`, `REVIEW_DAYS = 30`; `priority`, `cmp`, `parked(p, cutoff) -> bool`, `queued(&Intent) -> bool`, `pick_order`, `review_queue(&Listing, cutoff, now) -> Vec<&Intent>`, `last_review(&Listing) -> Option<DateTime<FixedOffset>>`, `review_due`; `ReviewDue::{Monthly { last: Option<DateTime<FixedOffset>> }, NothingAtCutoff}`; `Scores { u, i, a: Option<u8> }`, `parse_scores(&[impl AsRef<str>]) -> Result<Scores, String>` (also used by `add`). |
| `src/review.rs` | `run(&Store, &mut dyn BufRead, &mut dyn Write, now) -> Result<Tally, String>`; `keep(&Store, id, now)`, `rescore(&Store, id, Scores, now)`, `drop(&Store, id, now)` → `Result<Intent, StoreError>`; `Tally { kept, rescored, dropped, left: usize }`. |
| `src/intents/intent.rs` | `reviewed` (RFC 3339 field, as `started`), `reviewed() -> Option<DateTime<FixedOffset>>`. |
| `src/cli.rs` | `towercab [--config <file>] review` → `review::run(store, stdin, stdout, store::now())`; exit 0 after the walk (quit too), 1 on an error (`towercab: <reason>`). |

**Review** (stdout; each prompt flushed, no newline after it; `now` taken once at start; values through `one_line`)

```
<n> to review (parked, or not reviewed for 30 days)

[<k>/<n>] <id> <repo>: <title> · p<p> u<u> i<i>[ a<a>] · <next|parked> · <reviewed YYYY-MM-DD|never reviewed>
  <dir>/intent.md
keep, rescore, drop or quit? [k/r/d/q] 
```

- An answer is one input line, trimmed, any case. `k`: writes `reviewed`; prints `kept`.
  `r`: asks `scores (now u<u> i<i>[ a<a>]): `; `parse_scores` over its words, at least one
  (`want at least one of uN, iN, aN`); an error prints and asks again; writes the given scores +
  `reviewed`; prints `rescored: p<old> → p<new>[ (parked)]`. `d`: `stage: dropped` + `reviewed`;
  prints `dropped: done/<id>-<slug>`. `q` or EOF (at either prompt): stop, nothing written for it.
  Anything else: `want k, r, d or q`, asks again.
- A refused update prints `not changed: <reason>` and goes on; `StoreError::Sync` stops (exit 1).
- Empty queue → `nothing to review`. End, after a blank line: `kept <k>, rescored <r>, dropped <d>, left <l>` (left = unanswered or refused).

## Out of scope

- Size/effort term: add once [metrics](metrics.md) measure real cost per intent.
- Automatic aging: a parked intent's score never rises on its own.
- A `drop` command outside `review`; review from Telegram.

## Decisions

- `2i + u`: weighted sum like WSJF's cost-of-delay numerator; importance ×2 so
  important-but-not-urgent work isn't starved by urgent trivia.
- Cutoff 7: i ≥ 3 is never parked; i2 needs u ≥ 3; i1 needs u5. Parked intents still run once the important ones are done (my call).
- `reviewed:` in `intent.md`, not `last_reviewed` in SQLite (PRI-7 changed): the SQLite comes with the loop; the file is versioned and survives a new home. The last backlog review = the newest `reviewed` anywhere (`last_review`); dropped intents keep theirs, so no other state.
- The review walks queued intents only: in-flight or waiting ones belong to a mission. A never-reviewed intent ages from `started` (else its ID), so a new one isn't stale; a parked one is walked until reviewed, then every 30 days.
- One commit per answer (`Store::update`): a stopped walk keeps what was decided; the closure re-checks `queued` because the loop may pick the intent meanwhile. Like `add`, `review` writes through the store, not a `commands` row ([LOOP-15](loop.md)): the store's lock makes it safe beside the loop.
- Injected streams and EOF = quit, no TTY check: tests and pipes drive it. Rescore takes `add`'s score words; scores not given stay. Drop asks no confirmation: the folder stays in `done/` and git.
- Review due needs a non-empty queue: a message whose command shows nothing is noise.
- Parked-after-important already follows from PRI-4 (parked ⇔ `p < cutoff` ≤ every other `p`); `pick_order` partitions anyway, so a later order term can't break it. Unknown, dropped or cyclic `after:` ids are never done, so `pick_order` leaves those intents out; the loop writes `waiting: bad after:` ([LOOP-5](loop.md)).
- A dropped prerequisite blocks its dependents (PRI-5 changed from "finished"): they were written to build on its work; I decide (drop them too, or remove the `after`). `TODO.md` keeps `after <id>` on them.
- PRI-8's message, its once-per-30-days limit (the outbox's last send) and the `status` line are verified where they are built: [LOOP-13](loop.md) `test_status`, [LOOP-14](loop.md) `test_templates`. This intent builds `review_due`.
