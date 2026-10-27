---

name: intent
description: Capture a new intent for Towercab with the owner - ask what an analyst would, write intents/<id>-<slug>/intent.md from the template, propose u/i scores and commit it to main of the intents repo. Use when the owner types /intent or asks to add, capture or file an intent.
---

# /intent

Turn what the owner describes into one intent file on `main` of their `intents` repo. On `main` means
accepted: Towercab may pick it up as soon as it lands, so get it right before committing.
Rules: Towercab's `specs/intents.md` (INT-2, INT-3, INT-9) and `specs/priority.md`.

## 1. Note the start

First thing, note the conversation's start time with its offset (`date -Iseconds`;
on claude.ai, the current local time). It becomes `started:` and the ID.

## 2. Ask like an analyst

Let the owner describe the problem in their words. Then ask, a few questions at a time, only
what you can't infer:
- **Scope**: which repo, which part; what is explicitly not included.
- **Users and systems**: who or what is affected.
- **Constraints**: deadlines, compatibility, things that must not change.
- **What success looks like**: observable outcomes a reviewer can check one by one.
- **Open questions**: what is still undecided.

A thin intent is fine when they want one: only `repo` and the title are required.

## 3. Write the template

```
---
repo: <repo>
u: <1-5>
i: <1-5>
source: me
started: <conversation start, RFC 3339 with offset, e.g. 2026-10-21T09:05:00+02:00>
---

# Intent: <title>

## Problem
<why this matters, in their words>

## Proposed outcome
- <one checkable outcome per bullet; the PR review checks each one>

## Affected users and systems
## Constraints
## Open questions
```

- Propose `u` and `i` against the anchors (from `priority.md`), each with a one-line reason:

  |     | 1            | 2            | 3          | 4              | 5                  |
  | --- | ------------ | ------------ | ---------- | -------------- | ------------------ |
  | u   | someday      | this quarter | this month | this week      | now / blocking     |
  | i   | nice to have | small gain   | real value | core to a goal | goal depends on it |

- Never start a prose or bullet line with three backticks or three tildes: Towercab reads it as a
  code fence, and an unclosed one makes the whole intent unreadable. Quote code inline with single
  backticks; a real code block opens and closes on lines of its own.
- Leave `a` out unless the owner gives it (autonomy is their call).
- Optional keys only when they ask: `after: [<ids>]`, `model`, `review`, `unlock: [<globs>]`.
- Show them the whole file; apply their corrections; commit only after their yes.

## 4. ID and folder

- ID = `started` in local time as `YYMMDD-HHMM`. If any folder in `intents/` or `done/`
  (readable or not) or any ID in `done/legacy.md` already has it, add `-2`, then `-3`, ...
  IDs are never reused.
- Slug from the title: lowercase ASCII; drop `'` and `’`; every run of other characters
  outside `[a-z0-9]` becomes one `-`; trim `-`; cut to 48 characters and trim `-` again;
  empty → `intent`; starts with a digit → put `n` in front.
- File: `intents/<id>-<slug>/intent.md`. Never edit `TODO.md` or `DONE.md`: Towercab generates them.

## 5. Commit to main

With a shell (Claude Code):

```
remote=<[intents].remote, else [tasks].remote, in ~/.config/towercab/config.toml>
dir=$(mktemp -d) && git clone --quiet "$remote" "$dir" && cd "$dir"
# check the ID against intents/, done/ and done/legacy.md in this fresh clone, then write the file
git add intents/<id>-<slug>/intent.md
git commit -q -F - <<'INTENT_MSG'
docs(intents): add <id> <title>
INTENT_MSG
git push origin HEAD:main
```

The title reaches git only as the body of that quoted heredoc (or `git commit -F <file>`):
never put it in double quotes, `$(...)` or backticks on a command line. Titles hold backticks
(e.g. ``Repo files, protected paths and `towercab protect` ``), and the shell would run them.
The delimiter is `INTENT_MSG`, never `EOF`: a line `EOF` inside an outer heredoc would end it.

A rejected push: `git pull --rebase origin main`, check the ID again (a clash → next suffix,
`git mv` the folder, `git commit --amend -q -F -` with the same heredoc), push again.

On claude.ai: use the GitHub connector to create `intents/<id>-<slug>/intent.md` on `main` of the
`intents` repo with the commit message `docs(intents): add <id> <title>`; list `intents/`, `done/`
and `done/legacy.md` first for the ID check.

Finish by telling the owner the ID and the file's path.
