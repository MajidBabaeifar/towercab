# Priority

**Status:** Live · **Prefix:** PRI

## Purpose

Which intent Towercab works on next. The owner scores each intent for urgency and importance; code,
never a model, turns the scores into one order. Intents below a cutoff wait until the owner raises
them.

## Requirements

### PRI-1 · Scores

Every intent has an urgency `u` and an importance `i` from 1 to 5, and optionally an autonomy `a`.

- Enforced when an intent is read and written ([INT-2](intents.md)) and by the score words of `add`
  (`uN`, `iN`, `aN`, each at most once, else
  `bad score "<s>": want uN, iN or aN with N 1-5, each once`).
- Verified by: `priority: scores are 1 to 5`

### PRI-2 · Defaults

A missing urgency or importance counts as 3; a missing autonomy stays missing.

- Applied on read, never written. No `a` counts as a5 ([AUT-9](autonomy.md)).
- Verified by: `priority: missing scores count as 3`

### PRI-3 · Priority score

An intent's priority is twice its importance plus its urgency.

- `priority(u, i) = 2 * i + u`, from 3 to 15.
- Verified by: `priority: score is 2i + u`

### PRI-4 · Order

Higher priority goes first; between equal priorities, the older intent goes first.

- Sort by priority descending, then ID ascending (`YYMMDD`, `HHMM`, then the `-n` suffix, none = 1).
- Verified by: `priority: order is priority then age`

### PRI-5 · Cutoff and parked intents

An intent below the cutoff is parked: shown, but never started on its own.

- `priority < [intents].cutoff` (1–15, default 7) → parked. `next`, `status` and the UI show it as
  parked with `raise u or i to run it`. It runs once the owner raises a score, or names it
  (`run --intent`).
- The picker's list: open intents with no `stage` and no `waiting`, whose `after` IDs are all done,
  in PRI-4 order, at or above the cutoff first, then parked ones.
- Verified by: `priority: parked intents wait`, `priority: after waits for done`

### PRI-6 · Order is computed, never stored

The order is worked out on every read and never written into an intent.

- `TODO.md`'s Next and Parked sections and the UI's queue show it.
- Verified by: `priority: TODO shows the order`

### PRI-7 · Backlog review

Removed: never used; parked as intent 261026-2204-5.

### PRI-8 · Review due reminder

Removed: with PRI-7.

### PRI-9 · Dropping

Dropping an intent marks it `dropped` and moves it to `done/`; intents are never deleted.

- Through the store: `stage: dropped`, `finished: <now>`, folder moved to `done/`. Triggered by
  `towercab drop <id>`, the UI, or closing one of its PRs ([PIP-43](pipeline.md)). `DONE.md` lists it
  as dropped.
- Verified by: `priority: drop moves the intent to done`

## Out of scope

- Model-suggested scores outside the `/intent` skill.

## Decisions

- Importance counts double: an important intent should beat an urgent trivial one.
- Order is code, not a model: it must be predictable and explainable in one line.
