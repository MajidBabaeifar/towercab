# Gradient

**Status:** Draft · **Prefix:** GRD

## Purpose

Order tasks by what matters, with arithmetic I can predict.

## Requirements

| ID | Requirement | Verified by |
|---|---|---|
| GRD-1 | Every task has `u` (urgency), `i` (importance), `a` (autonomy), integers 1–5. | test_scores_range |
| GRD-2 | Missing scores default to `u3 i3 a2`. | test_defaults |
| GRD-3 | `priority = 2*i + u` (3–15). | test_priority |
| GRD-4 | Order: priority desc, then `created_at` asc. Computed by code, never by a model. | test_order |
| GRD-5 | `priority < cutoff` (config `gradient.cutoff`, default 7) → parked: never picked automatically. | test_cutoff |
| GRD-6 | `baton review` walks parked tasks and tasks with `last_reviewed` ≥ 30 days old: keep, rescore, drop. Sets `last_reviewed`. | test_review |
| GRD-7 | A review is prompted monthly, and when no open task is at or above the cutoff. | test_review_trigger |
| GRD-8 | Dropping sets status `Dropped`; tasks are never deleted. | test_drop |

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
