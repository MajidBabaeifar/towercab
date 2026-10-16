# Tasks

**Status:** Draft (Rust rewrite; TSK-1–5, 8, 10 live in the Python version on branch `python`) · Draft: rest · **Prefix:** TSK

## Purpose

What a task is, and where tasks live.

## Requirements

| ID | Requirement | Verified by |
|---|---|---|
| TSK-1 | Store: private repo `gradient-tasks`. `TODO.md` = open tasks, `DONE.md` = finished/dropped, `tasks/<id>.md` = plan, questions, notes (only when needed). | manual |
| TSK-2 | Line: `- [m] [<id>] [u<n> i<n> a<n>] <repo>: <title> [after:<id>,…] [@model] [review:<model>]`, then optional `  <key>: <value>` lines (`done when`, `pr`, `note`, `retry: fresh`). Marker `[ ]` open, `[~]` running, `[!]` waiting on me. A line that doesn't parse is kept verbatim and reported. | test_every_part, test_errors |
| TSK-3 | ID = creation time `YYMMDD-HHMM` (local); same-minute clash (incl. IDs in DONE.md) → `-2`, `-3`. Creation time is read from the ID; no separate field. A task without ID or `u`/`i` gets them (defaults u3 i3) the first time Towercab touches it; `a` is never filled in ([AUT-9](autonomy.md)). | test_normalize_and_add_assign_ids, test_ids_never_reused |
| TSK-4 | Commands accept any unique ID suffix (`towercab approve 1446`). | test_get_by_suffix_must_be_unique |
| TSK-5 | Towercab pulls before reading and commits + pushes each write straight to `main`; on conflict it rebases and retries, never overwrites my edits. | test_concurrent_edits_both_kept |
| TSK-6 | Done: line moves to `DONE.md` as `<date> <id> <repo>: <title> · PR · cost · agent time · attempts`. | test_done_line |
| TSK-7 | Missions, model cooldowns, outbox, commands, repo caps and freezes, and `last_reviewed` live in Towercab's SQLite ([LOOP-1](loop.md)), not in the repo. | test_runtime_local |
| TSK-8 | Towercab touches tasks only through a store interface: `list`, `get`, `add`, `update`. | test_continuations_and_errors |
| TSK-9 | `towercab add "<repo>: <title>" [uN iN aN]` appends a task with ID and defaults, then sorts ([PRI-6](priority.md)). | test_add |
| TSK-10 | Parse → write of an untouched file is byte-identical; a changed task is rewritten canonically, every other line kept. | test_round_trip_is_byte_identical |
| TSK-11 | `review:<model>` is a trailing token (either order with `@model`), given once; written after `@model`. Sets the reviewer model ([PIP-4](pipeline.md)). | test_review_attr |

## Out of scope

- Other stores (Notion, DB). The interface leaves room; nothing else is built.

## Decisions

- Markdown in git over a Notion database: versioned, readable by any agent, no API key
  or rate limit, and a future MCP serves the same files, so nothing to migrate.
  Cost: phone edits go through the GitHub app or website.
- Separate repo, not a folder in Towercab: the list is data edited all day by me and Towercab,
  without PRs; it holds tasks for every repo.
- Timestamp IDs: sort by age for free; minute precision is enough for one person.
