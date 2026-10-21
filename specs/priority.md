# Priority

**Status:** Draft (Rust rewrite) · **Prefix:** PRI

## Purpose

Order intents by what matters, with arithmetic I can predict.

## Requirements

| ID | Requirement | Verified by |
|---|---|---|
| PRI-1 | Every intent has `u` (urgency), `i` (importance), integers 1–5; `a` (autonomy, 1–5) is optional. | test_scores_range |
| PRI-2 | Missing `u`, `i` default to 3; missing `a` stays missing ([AUT-9](autonomy.md)). | test_defaults |
| PRI-3 | `priority = 2*i + u` (3–15). | test_priority |
| PRI-4 | Order: priority desc, then ID asc (= oldest first). Computed by code, never by a model. | test_order |
| PRI-5 | `priority < cutoff` (`[intents].cutoff`, default 7) → parked: picked only when no intent at or above the cutoff is runnable ([LOOP-5](loop.md)). | test_cutoff, test_parked_after_important |
| PRI-6 | Order is computed on every read, never stored: the Next and Parked sections of the generated `TODO.md` show it ([INT-6](intents.md)). | test_todo_order |
| PRI-7 | `towercab review` walks parked intents and intents not reviewed for ≥ 30 days (`last_reviewed` in Towercab's SQLite): keep, rescore, drop. | test_review |
| PRI-8 | Review due (monthly, or no open intent at or above the cutoff) → one [LOOP-14](loop.md) message `review the backlog: towercab review`, at most once per 30 days; shown in `status`. | test_review_trigger |
| PRI-9 | Dropping sets `stage: dropped` and moves the file to `done/`; intents are never deleted. | test_drop |

**Anchors**

| | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| u | someday | this quarter | this month | this week | now / blocking |
| i | nice to have | small gain | real value | core to a goal | goal depends on it |

`a`: see [autonomy.md](autonomy.md).

## Out of scope

- Size/effort term: add once [metrics](metrics.md) measure real cost per intent.
- Automatic aging: a parked intent's score never rises on its own.

## Decisions

- `2i + u`: weighted sum like WSJF's cost-of-delay numerator; importance ×2 so
  important-but-not-urgent work isn't starved by urgent trivia.
- Cutoff 7: i ≥ 3 is never parked; i2 needs u ≥ 3; i1 needs u5. Parked intents still run once the important ones are done (my call).
