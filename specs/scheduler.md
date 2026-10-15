# Scheduler

**Status:** Draft · **Prefix:** SCH

## Purpose

Hand the most important runnable task to exactly one agent.

## Requirements

| ID | Requirement | Verified by |
|---|---|---|
| SCH-1 | Picks the first task in [priority](priority.md) order that is open `[ ]`, not parked, has every `after` task done, and whose repo has a free slot (`repos.<name>.workers`, default 1). | test_pick |
| SCH-2 | Tasks waiting on me `[!]` are skipped, not waited on. | test_skip_waiting |
| SCH-3 | Claims are atomic in baton's SQLite (`UPDATE … WHERE status='open' RETURNING`); no task is ever held by two workers. | test_claim_race |
| SCH-4 | A claim is a lease: heartbeat every 60 s; none for 10 min → task back to open. | test_lease_expiry |
| SCH-5 | Each run uses its own git worktree and branch `baton/<id>-<slug>`. | test_worktree |
| SCH-6 | baton is the only writer of task markers, except me turning `[!]` back to `[ ]` to approve. | review |
| SCH-7 | `baton inbox` lists what waits on me: plans to write (a1), plans to approve (a2), PRs to review, questions. | test_inbox |

## Out of scope

- Claims across machines (laptop + VPS at once).

## Decisions

- One task = one agent session; a failed check resumes that session with the error,
  so no outer Ralph-style loop.
