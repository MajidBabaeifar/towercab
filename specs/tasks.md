# Tasks

**Status:** Draft · **Prefix:** TSK

## Purpose

What a task is, and where tasks live.

## Requirements

| ID | Requirement | Verified by |
|---|---|---|
| TSK-1 | Store: private repo `gradient-tasks`. `TODO.md` = open tasks, `DONE.md` = finished/dropped, `tasks/<id>.md` = plan, questions, notes (only when needed). | manual |
| TSK-2 | Line: `- [m] <id> u<n> i<n> a<n> <repo>: <title> [after:<id>…] [@model]`, optional next line `  done when: …`. Marker `[ ]` open, `[~]` running, `[!]` waiting on me. | test_parse_line |
| TSK-3 | ID = creation time `YYMMDD-HHMM` (local); same-minute clash → `-2`, `-3`. Creation time is read from the ID; no separate field. | test_id |
| TSK-4 | Commands accept any unique ID suffix (`baton approve 1446`). | test_id_suffix |
| TSK-5 | Baton pulls before reading and commits + pushes each write straight to `main`; on conflict it rebases and retries, never overwrites my edits. | test_store_conflict |
| TSK-6 | Done: line moves to `DONE.md` as `<date> <id> <repo>: <title> · PR · cost · agent time · attempts`. | test_done_line |
| TSK-7 | Claims, leases, runs, PR links in flight and `last_reviewed` live in Baton's SQLite, not in the repo. | test_runtime_local |
| TSK-8 | Baton touches tasks only through a store interface: `list`, `get`, `add`, `update`. | test_store_interface |
| TSK-9 | `baton add "<repo>: <title>" [uN iN aN]` appends a task with ID and defaults, then sorts ([PRI-6](priority.md)). | test_add |

## Out of scope

- Other stores (Notion, DB). The interface leaves room; nothing else is built.

## Decisions

- Markdown in git over a Notion database: versioned, readable by any agent, no API key
  or rate limit, and a future MCP serves the same files, so nothing to migrate.
  Cost: phone edits go through the GitHub app or website.
- Separate repo, not a folder in Baton: the list is data edited all day by me and Baton,
  without PRs; it holds tasks for every repo.
- Timestamp IDs: sort by age for free; minute precision is enough for one person.
