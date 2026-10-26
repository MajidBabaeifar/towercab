# Intents

**Status:** Draft · **Prefix:** INT

## Purpose

An intent is the owner's description of a change: the problem, the outcome wanted, and how urgent and
important it is. Intents live as Markdown files in a private `intents` repo, so the owner can write
them anywhere (a laptop, a phone, Claude) and Towercab picks them up from there. Towercab writes back
only a few lifecycle fields and two generated overview files.

## Requirements

### INT-1 · The intents repo

Each intent is a folder in the `intents` repo, and finished ones move to `done/`.

- Layout: `intents/<id>-<slug>/intent.md` (the owner's) and `plan.md` (arrives through the plan PR,
  [PIP-46](pipeline.md)); finished folders move to `done/<id>-<slug>/` (`git mv`, when `stage` becomes
  `done` or `dropped`). `TODO.md` and `DONE.md` are generated (INT-6) and never edited by hand.
- A folder whose name isn't `<id>-<slug>` (INT-3) or that has no `intent.md` is listed as unreadable
  (INT-11). Plain files in `intents/` and `done/` are ignored, except `done/legacy.md`.
- Symlinks are never followed: a symlink in place of `intents/`, `done/`, a folder or an `intent.md`
  is unreadable (`symlink`), and no read or write goes through one.
- Towercab's checkout is `[intents].path` (default `<home>/intents`), cloned from `[intents].remote`
  when missing.
- Verified by: `intents: layout of open and done folders`, `intents: symlinks are never followed`

### INT-2 · The intent file

An intent file is YAML front matter followed by a Markdown body with a title and a few sections.

- Front matter: the lines between a first line `---` and the next `---` line, parsed as YAML (the
  `yaml` package). Fields the owner writes: `repo` (required; `[A-Za-z0-9._-]+`, not starting with `-`,
  not `.` or `..`), `u`, `i`, `a` (integers 1–5; `a` optional), `after` (list of IDs, or one ID),
  `model`, `review` (a model name), `source` (`me` or another origin), `started` (RFC 3339),
  `unlock` (list of path globs) and `network` (list of domains): access granted up front
  ([AUT-14](autonomy.md)). Any other key is kept verbatim and never rewritten. A known key with the
  wrong type, a duplicate key, or another line at column 0 makes the file unreadable (INT-11).
- Body: everything after the closing `---`, kept as raw text. The first `# ` line is the title
  (`# Intent: <title>`, the `Intent: ` prefix optional). Sections: `## Problem`,
  `## Proposed outcome` (bullets; the review checks each one, [PIP-5](pipeline.md)),
  `## Affected users and systems`, `## Constraints`, `## Open questions`, and Towercab's
  `## Towercab` and `## Answers` (INT-15). Only `repo` and the title are required.
- `towercab add "<repo>: <title>" [uN] [iN] [aN]` writes a thin intent: `repo`, the scores given,
  `source: me`, `started` (now, local offset), a blank line and `# Intent: <title>`; it prints
  `<id> intents/<id>-<slug>/intent.md`.
- Verified by: `intents: parse a full intent`, `intents: a thin intent is valid`, `intents: add writes a thin intent`

### INT-3 · IDs and slugs

An intent's ID is its creation time to the minute, and its slug comes from the title.

- ID = `YYMMDD-HHMM` in local time; a clash with any folder in `intents/` or `done/`, or an ID in
  `done/legacy.md`, adds `-2`, `-3`, and so on. IDs are never reused.
- Slug: lowercase ASCII; `'` and `’` dropped; every run of other characters outside `[a-z0-9]`
  becomes one `-`; trimmed of `-`; cut to 48 characters and trimmed again; empty → `intent`; a leading
  digit gets an `n` prefix. The slug is fixed at creation.
- Commands accept any unique suffix of an open intent's ID: an exact match first, else the one ID
  ending with it; none → `no open intent matches <s>`; several → `<s> matches <n> intents: <ids>`.
- Verified by: `intents: IDs are never reused`, `intents: a unique suffix resolves`, `intents: slug rules`

### INT-4 · Accepted means on main

An intent is accepted when it is on the `main` branch of the intents repo.

- The owner's commits to `main` are accepted as they are. Anything a machine writes for the owner to
  accept (a new intent, a plan) arrives as a pull request, and merging it accepts it.
- The store reads only its checkout's `main` working tree and refuses a checkout on another branch
  (`intents: <path> is on <branch>, not main`).
- Verified by: `intents: only main is accepted`

### INT-5 · Lifecycle fields

Towercab records where an intent is in a few front-matter fields, so the owner can see it from the
file alone.

- `stage`: absent = accepted, not started; then `spec`, `plan`, `code`, `done` or `dropped`
  (the phase of its mission, [LOOP-3](loop.md)). `waiting: <what the owner must do>` while it waits on
  the owner. `spec_pr`, `plan_pr`, `pr` (the code PR): their URLs once opened. At `done`: `cost`
  (USD, 2 decimals), `agent_time` (seconds), `attempts`; with `done` or `dropped`: `finished`
  (RFC 3339). A worker may lower `a` and add `lower_why` ([AUT-7](autonomy.md)).
- Written only through `setField(key, value)` and `removeField(key)` on lifecycle fields: a changed
  key's lines are replaced by one `key: value` line in place, a new key goes last before the closing
  `---`, and every other line stays byte-identical. Strings are written plain when they read back
  unchanged, else double-quoted; lists in flow style `[a, b]`.
- `retry: fresh`, written by the owner, starts a new attempt ([LOOP-18](loop.md)).
- Verified by: `intents: lifecycle fields keep other lines`, `intents: done moves the folder`

### INT-6 · Generated overviews

`TODO.md` and `DONE.md` give the owner a one-page view of the repo, regenerated on every write.

- `TODO.md`: Waiting on me (with what is asked), In flight (stage), Next (priority order,
  [PRI-4](priority.md)), Parked (below the cutoff), Can't read. `DONE.md`: newest first, date, ID,
  repo, title, PR, cost, agent time, attempts; then `done/legacy.md` verbatim under `## Before intents`.
- Each line links the ID to its `intent.md`. Empty sections are left out; nothing at all →
  `Nothing open.` / `Nothing done.` Each file starts with a comment saying it is generated.
- Verified by: `intents: TODO view`, `intents: DONE view`

### INT-7 · Intents drafted from issues

Removed: not used in v1 (no drafts were ever made). Parked as intent 261026-2204-3.

### INT-8 · Other machine routes

Removed: depended on maintain and review findings, both parked.

### INT-9 · The /intent skill

A Claude Code skill helps the owner write a good intent through a short conversation.

- `skills/intent/SKILL.md` (front matter `name: intent`, `description`); `install.sh` links it to
  `~/.claude/skills/intent`. Claude asks what an analyst would (scope, users, constraints, what
  success looks like), writes the template (INT-2), proposes `u` and `i`, leaves `a` out unless the
  owner gives it, and commits `docs(intents): add <id> <title>` to `main`.
- Verified by: `intents: the skill names every section`, manual (run `/intent` in a new session: a folder lands on `main`)

### INT-10 · Syncing with GitHub

Towercab pulls before every read and pushes every write, and never overwrites the owner's edits.

- Every read and write holds a lock file in the checkout's git dir (one at a time across processes).
  Read: `git fetch origin main`, fast-forward; local commits a killed run left behind are rebased onto
  `origin/main` (a conflict only in `TODO.md`/`DONE.md` takes `main`'s side; any other drops them and
  logs their subjects). Write: read, apply the change, regenerate both views, commit
  `towercab: <what> <id>`, `git push origin HEAD:main`.
- A rejected push replays the change: reset to `origin/main`, re-read, apply the same change again,
  push; at most 3 retries, then `push failed 4 times: <stderr>`. Nothing changed → no commit.
- Git runs with `GIT_TERMINAL_PROMPT=0`, no hooks, and the bot's name and email when the App
  identity is set ([LOOP-19](loop.md)).
- Verified by: `intents: concurrent edits are both kept`, `intents: parse then write is byte-identical`, `intents: a rejected push replays the change`, `intents: an unpushed commit is recovered`

### INT-11 · Files that can't be read

A file that doesn't parse is never picked or rewritten; it is shown with the reason.

- Listed under Can't read in `TODO.md` and in the UI as `<path>: <reason>` (for example
  `intents/<dir>/intent.md: u must be an integer 1-5`). `get` and `update` on its ID fail with that
  reason; other writes leave its bytes alone. Two folders with one ID are both unreadable
  (`duplicate id`).
- Verified by: `intents: a bad file is reported, not touched`

### INT-12 · The store

Everything Towercab does with intents goes through one store interface.

- `src/intents/store.ts`: `Store.list(): Listing`, `get(idOrSuffix): Intent`,
  `add(NewIntent): Intent`, `update(idOrSuffix, what, (intent) => void): Intent` (commit
  `towercab: <what> <id>`; a thrown error writes nothing), `hasMark(mark)` (finds a commit trailer in
  the last 200 commits, so a step re-run after a crash doesn't write twice, [LOOP-6](loop.md)).
- Errors: `SyncError` (clone, pull or push failed; retried by the loop) or `RefusedError` (anything
  else); the message is the reason.
- Verified by: `intents: store interface`

### INT-13 · Migrating the v1 task list

Removed: a one-time job that ran in v1.

### INT-14 · Answers section

Removed: in v1 already; now INT-15.

### INT-15 · Answers and notes in the file

Answers the owner gives outside GitHub, and Towercab's questions before any PR exists, are kept in
the intent file so the history stays in the intents repo.

- `## Towercab` (last but one): Towercab's current note or question to the owner, replaced whole on
  each write and removed when empty.
- `## Answers` (last): one `- <local time>: <text>` line per answer from the UI or `towercab answer`;
  every later worker prompt includes the section.
- Verified by: `intents: answers are appended`, `intents: the Towercab note is replaced whole`

## Out of scope

- Other stores (Notion, Jira).
- Intents drafted from GitHub issues or monitoring alerts (parked, INT-7).

## Decisions

- One folder per intent in a separate repo: intents span several product repos, and the owner can
  write them from any device.
- Front matter is edited line by line, never re-serialised, so the owner's comments, order and
  quoting survive.
- A rejected push replays the change instead of rebasing, so generated views never conflict.
- `stage` names the three phases a person cares about (`spec`, `plan`, `code`), not the internal
  steps; the step is in the UI and `status`.
- v2 keeps v1's file format, so the existing intents repo works unchanged; v1's `test`, `deploy` and
  `maintain` stage values read as `code`.
