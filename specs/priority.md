# Priority

**Status:** Draft (Rust rewrite) · **Prefix:** PRI

## Purpose

Order tasks by what matters, with arithmetic I can predict.

## Requirements

| ID | Requirement | Verified by |
|---|---|---|
| PRI-1 | Every task has `u` (urgency), `i` (importance), integers 1–5; `a` (autonomy, 1–5) is optional. | test_scores_range |
| PRI-2 | Missing `u`, `i` default to 3; missing `a` stays missing ([AUT-9](autonomy.md)). | test_defaults |
| PRI-3 | `priority = 2*i + u` (3–15). | test_priority |
| PRI-4 | Order: priority desc, then ID asc (= oldest first). Computed by code, never by a model. | test_order |
| PRI-5 | `priority < cutoff` (`[tasks].cutoff`, default 7) → parked: picked only when no task at or above the cutoff is runnable ([LOOP-5](loop.md)). | test_cutoff, test_parked_after_important |
| PRI-6 | `towercab sort` rewrites `TODO.md` in this order and fills in missing IDs and `u`/`i` (never `a`, [TSK-3](tasks.md)); runs on `towercab add`, never mid-edit. | test_sort |
| PRI-7 | `towercab review` walks parked tasks and tasks not reviewed for ≥ 30 days (`last_reviewed` in Towercab's SQLite): keep, rescore, drop. | test_review |
| PRI-8 | Review due (monthly, or no open task at or above the cutoff) → one [LOOP-14](loop.md) message `review the backlog: towercab review`, at most once per 30 days; shown in `status`. | test_review_trigger |
| PRI-9 | Dropping moves the task to `DONE.md` marked `dropped`; tasks are never deleted. | test_drop |

**Anchors**

| | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| u | someday | this quarter | this month | this week | now / blocking |
| i | nice to have | small gain | real value | core to a goal | goal depends on it |

`a`: see [autonomy.md](autonomy.md).

## Out of scope

- Size/effort term: add once [metrics](metrics.md) measure real cost per task.
- Automatic aging: a parked task's score never rises on its own.

## Decisions

- `2i + u`: weighted sum like WSJF's cost-of-delay numerator; importance ×2 so
  important-but-not-urgent work isn't starved by urgent trivia.
- Cutoff 7: i ≥ 3 is never parked; i2 needs u ≥ 3; i1 needs u5. Parked tasks still run once the important ones are done (my call).
