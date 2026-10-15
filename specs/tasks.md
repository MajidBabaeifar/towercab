# Tasks

**Status:** Draft · **Prefix:** TSK

## Purpose

What a task is, and where tasks live.

## Requirements

| ID | Requirement | Verified by |
|---|---|---|
| TSK-1 | Fields: `id`, `title`, `repo`, `u`, `i`, `a`, `status` (Open, Running, Waiting on you, Done, Dropped), `done_when`, `model`, `after[]`, `pr`, `last_reviewed`, `created_at`, `body` (markdown: plan, questions, notes). | test_task_schema |
| TSK-2 | baton touches tasks only through a store interface: `list`, `get`, `add`, `update`. | test_store_interface |
| TSK-3 | v1 store: Notion database "Gradient", one row per task, page content = `body`. | manual: row ↔ task |
| TSK-4 | Claims, leases and runs live in baton's SQLite, never in the store; the store only shows `status`. | test_runtime_local |
| TSK-5 | `baton add "<title>" [uN iN aN] [--repo R]` creates a task with defaults, returns its ID. | test_add |
| TSK-6 | Changing stores = export through the interface; IDs are kept. | test_export |

## Out of scope

- Two-way sync between stores.

## Decisions

- Notion for v1: reachable from my phone and every Claude chat today. The field list,
  not Notion, is the contract, so an own MCP/SQLite store later is a new adapter.
