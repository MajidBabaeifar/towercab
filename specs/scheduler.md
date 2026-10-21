# Scheduler

**Status:** Removed: superseded by [loop.md](loop.md) (Rust rewrite); Python version on branch `python` · **Prefix:** SCH

## Purpose

Hand the most important runnable task to exactly one agent.

## Requirements

| ID | Requirement | Verified by |
|---|---|---|
| SCH-1 | Removed → LOOP-4, LOOP-5. Was: Picks the first task in [priority](priority.md) order that is open `[ ]`, not parked, has every `after` task done, and whose repo has a free slot (`repos.<name>.workers`, default 1). | — |
| SCH-2 | Removed → LOOP-5. Was: Tasks waiting on me `[!]` are skipped, not waited on. | — |
| SCH-3 | Removed → LOOP-4, LOOP-15 (one loop per home). Was: Claims are atomic in Towercab's SQLite (`UPDATE … WHERE status='open' RETURNING`); no task is ever held by two workers. | — |
| SCH-4 | Removed → LOOP-6, LOOP-7. Was: A claim is a lease: heartbeat every 60 s; none for 10 min → task back to open. | — |
| SCH-5 | Removed → LOOP-8, PIP-2. Was: Each run uses its own git worktree and branch `towercab/<id>-<slug>`. | — |
| SCH-6 | Removed → TSK-5. Was: Towercab is the only writer of task markers, except me turning `[!]` back to `[ ]` to approve. | — |
| SCH-7 | Removed → LOOP-13. Was: `towercab inbox` lists what waits on me: plans to write (a1), plans to approve (a2), PRs to review, questions. | — |

## Out of scope

- Claims across machines (laptop + VPS at once).

## Decisions

- One task = one agent session; a failed check resumes that session with the error,
  so no outer Ralph-style loop.
