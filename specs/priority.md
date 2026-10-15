# Priority

**Status:** Draft · **Prefix:** PRI

## Purpose

Order tasks by what matters, with arithmetic I can predict.

## Requirements

| ID | Requirement | Verified by |
|---|---|---|
| PRI-1 | Every task has `u` (urgency), `i` (importance), `a` (autonomy), integers 1–5. | test_scores_range |
| PRI-2 | Missing scores default to `u3 i3 a2`. | test_defaults |
| PRI-3 | `priority = 2*i + u` (3–15). | test_priority |
| PRI-4 | Order: priority desc, then ID asc (= oldest first). Computed by code, never by a model. | test_order |
| PRI-5 | `priority < cutoff` (config `priority.cutoff`, default 7) → parked: never picked automatically. | test_cutoff |
| PRI-6 | `baton sort` rewrites `TODO.md` in this order and fills in missing IDs and scores; runs on `baton add`, never mid-edit. | test_sort |
| PRI-7 | `baton review` walks parked tasks and tasks not reviewed for ≥ 30 days (`last_reviewed` in baton's SQLite): keep, rescore, drop. | test_review |
| PRI-8 | A review is prompted monthly, and when no open task is at or above the cutoff. | test_review_trigger |
| PRI-9 | Dropping moves the task to `DONE.md` marked `dropped`; tasks are never deleted. | test_drop |

**Anchors**

| | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| u | someday | this quarter | this month | this week | now / blocking |
| i | nice to have | small gain | real value | core to a goal | goal depends on it |

`a`: see [autonomy.md](autonomy.md).

## Out of scope

- Size/effort term: add once [metrics](metrics.md) measure real cost per task.
- Automatic aging; parked tasks only come back through review.

## Decisions

- `2i + u`: weighted sum like WSJF's cost-of-delay numerator; importance ×2 so
  important-but-not-urgent work isn't starved by urgent trivia.
- Cutoff 7: i ≥ 3 always runs; i2 needs u ≥ 3; i1 needs u5.
