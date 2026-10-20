# Tasks

**Status:** Removed: superseded by [intents.md](intents.md) · **Prefix:** TSK

## Purpose

What a task is, and where tasks live.

## Requirements

| ID | Requirement | Verified by |
|---|---|---|
| TSK-1 | Removed → INT-1. Was: Store: private repo `gradient-tasks`. `TODO.md` = open tasks, `DONE.md` = finished/dropped, `tasks/<id>.md` = plan, questions, notes (only when needed). | — |
| TSK-2 | Removed → INT-2. Was: Line: `- [m] [<id>] [u<n> i<n> a<n>] <repo>: <title> [after:<id>,…] [@model] [review:<model>]`, then optional `  <key>: <value>` lines (`done when`, `pr`, `note`, `retry: fresh`). Marker `[ ]` open, `[~]` running, `[!]` waiting on me. A line that doesn't parse is kept verbatim and reported. | — |
| TSK-3 | Removed → INT-3. Was: ID = creation time `YYMMDD-HHMM` (local); same-minute clash (incl. IDs in DONE.md) → `-2`, `-3`. Creation time is read from the ID; no separate field. A task without ID or `u`/`i` gets them (defaults u3 i3) the first time Towercab touches it; `a` is never filled in ([AUT-9](autonomy.md)). | — |
| TSK-4 | Removed → INT-3. Was: Commands accept any unique ID suffix (`towercab approve 1446`). | — |
| TSK-5 | Removed → INT-10. Was: Towercab pulls before reading and commits + pushes each write straight to `main`; on conflict it rebases and retries, never overwrites my edits. | — |
| TSK-6 | Removed → INT-6. Was: Done: line moves to `DONE.md` as `<date> <id> <repo>: <title> · PR · cost · agent time · attempts`. | — |
| TSK-7 | Removed → LOOP-1. Was: Missions, model cooldowns, outbox, commands, repo caps and freezes, and `last_reviewed` live in Towercab's SQLite ([LOOP-1](loop.md)), not in the repo. | — |
| TSK-8 | Removed → INT-12. Was: Towercab touches tasks only through a store interface: `list`, `get`, `add`, `update`. | — |
| TSK-9 | Removed → LOOP-15. Was: `towercab add "<repo>: <title>" [uN iN aN]` appends a task with ID and defaults, then sorts ([PRI-6](priority.md)). | — |
| TSK-10 | Removed → INT-10. Was: Parse → write of an untouched file is byte-identical; a changed task is rewritten canonically, every other line kept. | — |
| TSK-11 | Removed → INT-2. Was: `review:<model>` is a trailing token (either order with `@model`), given once; written after `@model`. Sets the reviewer model ([PIP-4](pipeline.md)). | — |

## Out of scope

- Other stores (Notion, DB). The interface leaves room; nothing else is built.

## Decisions

- Markdown in git over a Notion database: versioned, readable by any agent, no API key
  or rate limit, and a future MCP serves the same files, so nothing to migrate.
  Cost: phone edits go through the GitHub app or website.
- Separate repo, not a folder in Towercab: the list is data edited all day by me and Towercab,
  without PRs; it holds tasks for every repo.
- Timestamp IDs: sort by age for free; minute precision is enough for one person.
