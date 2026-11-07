# Jira

**Status:** Draft · **Prefix:** JIRA

## Purpose

Towercab can take work from a Jira backlog as it does from GitHub issues: eligible tickets become
intents, and the pull requests it opens are linked back to the ticket. A ticket's key also shows in the
branch name and the titles of the code PR, for teams that expect it there. Towercab reads only what the
owner's filter returns and never changes a ticket's status. The GitHub-issue flow it follows is in
[intents.md](intents.md) (INT-20..INT-29).

## Requirements

### JIRA-1 · The `[jira]` config table

Towercab reads where Jira is, who the owner is there, which tickets are eligible and where the API token is kept from one config table.

- `[jira]`: `site` (the Jira Cloud URL, an `https://` URL such as `https://acme.atlassian.net`; `http://`
  only for `localhost` and `127.0.0.1`, for tests), `email` (the owner's Atlassian account email),
  `token_file` (path, `~/` allowed) and `jql` (the filter). All four are required once the table exists.
  Unknown keys are ignored ([LOOP-1](loop.md)).
- `token_file` must exist, be a regular file with mode 600 and hold one non-empty line; otherwise
  `config: <file>: jira.token_file <why>` (`is readable by group or others`, `is empty`, `does not exist`).
  The token is read when used, never cached on disk, never printed, never put in a Claude run's
  environment, and sent only to `site`, as HTTP basic auth with `email`.
- A bad `site` → `config: <file>: jira.site must be an https URL`; an empty `jql` →
  `config: <file>: jira.jql must not be empty`.
- Without a `[jira]` table nothing about Jira runs, and an installation without it behaves as before.
- Verified by: `jira: config reads the table`, `jira: config rejects a bad site`, `jira: config refuses a token file others can read`, `jira: no table means no Jira calls`

### JIRA-2 · Only the filter's tickets are read

Towercab never reads a ticket the owner's filter does not return.

- Every read goes through a search whose JQL is the configured `jql`; a lookup of one ticket by key
  is that JQL `AND key = <KEY>`, so a ticket outside the filter looks absent.
  No call fetches a ticket by key alone, and none lists projects or other tickets.
- Towercab asks only for the fields it needs: key, summary, description, project, components, labels.
  Comments by others and attachments are never fetched or put in a prompt.
- A ticket the search stops returning is left alone: its intent is not dropped, and nothing is written
  to it, except the links and comments of JIRA-6 and JIRA-7 on an intent that already exists.
- Verified by: `jira: a ticket outside the filter is never fetched`, `jira: a lookup repeats the filter`, `jira: only the needed fields are requested`

### JIRA-3 · Which repo a ticket belongs to

Each ticket is mapped to one of the owner's repos by its Jira project, component or label.

- `[jira.repos]` maps a repo name from `[repos]` to a list of selectors: `project:ABC`,
  `component:Billing`, `label:towercab-api`. Matching is exact and case-insensitive.
- A ticket matching the selectors of exactly one repo goes there. Matching none or several is skipped
  with a log line, and Towercab writes nothing to the ticket; the owner narrows the selectors or the filter.
- A selector naming a repo not in `[repos]` → `config: <file>: jira.repos names an unknown repo <name>`.
- Verified by: `jira: a project selector picks the repo`, `jira: a component or label selector picks the repo`, `jira: an ambiguous ticket is skipped`, `jira: an unknown repo in the mapping is a config error`

### JIRA-4 · The Jira poll

The loop looks for new eligible tickets every 5 minutes.

- As INT-21: each pass searches with the configured `jql`, reads at most 4 pages of 50 tickets, and
  skips the keys already taken (JIRA-5). Tickets beyond those pages wait for the next pass.
- A Jira failure (network, 401, 403, 429, 5xx) is a fault of Jira, not of an intent: it is logged, the
  pass ends for Jira only, a 429 honours `Retry-After`, and nothing is written for tickets it did not reach.
- Verified by: `jira: the poll runs every 5 minutes`, `jira: a Jira failure is a Jira fault`, `jira: a rate limit waits for Retry-After`, `jira: the poll continues on the next page`

### JIRA-5 · One intent per ticket, ever

Each ticket becomes at most one intent, even after that intent is done or dropped, and the intent records the ticket's key.

- The intent file has `repo`, `u`, `i`, `a` (JIRA-6), `source: jira`, `jira: <KEY>`, `started`, then the
  title (`<summary>`), `## Problem` and `## Proposed outcome`. The Jira site is not stored in the file;
  the key is enough while `[jira].site` is one site.
- It is proposed like an issue intent (INT-23): branch `jira/<repo>-<KEY>` in `<home>/issues`, an intent
  PR the owner merges, never merged by Towercab, and a step re-run after a crash opens no second PR.
- Dedupe on the `jira:` field across open, `done/` and dropped intents, and on any PR from the branch
  `jira/<repo>-<KEY>`, open, merged or closed (as INT-26).
- Verified by: `jira: a ticket becomes one intent PR`, `jira: nothing from a ticket reaches main before the owner merges`, `jira: a done intent blocks its ticket`, `jira: a closed intent PR is never proposed again`, `jira: a crash before the comment does not write twice`

### JIRA-6 · Scoring a ticket

A short Claude run with no tools reads the ticket's summary and description and proposes its scores, as it does for a GitHub issue.

- Same run, schema, retry and failure as INT-22, with the input: summary, description as plain text,
  and labels. The description arrives as Atlassian document format and is converted to plain text:
  paragraphs and list items on their own lines, links as their text and URL, code blocks kept,
  everything else (images, media, mentions' ids) dropped. Plain-text and null descriptions work too.
- Two bad results → a comment on the ticket asking the owner to write the intent by hand, and that
  ticket is not read again; the owner writes the intent by hand.
- Autonomy as INT-24 with `[intents].issue_a` and no label; the effective autonomy is at most 4
  ([AUT-13](autonomy.md)).
- Verified by: `jira: the scoring run gets no tools`, `jira: a description becomes plain text`, `jira: an empty description scores from the summary`, `jira: two bad results ask the owner to write it by hand`, `jira: a3 by default`

### JIRA-7 · Telling the ticket it is queued

Towercab comments once on the ticket with a link to the intent and its place in the queue.

- Once the intent is on `main`: one comment gives the intent's link, `u` and `i` with their reasons and
  its place in the queue ([PRI-4](priority.md)), in the [writing guide](../prompts/writing.md)'s style.
- Once means once: before posting, Towercab looks for its own earlier comment (it carries a hidden
  marker line with the intent ID) and a failed comment is retried without a second one.
- Verified by: `jira: the queued comment names scores and place`, `jira: a ticket is commented once`, `jira: a failed comment is retried once`

### JIRA-8 · Pull requests link back to the ticket

Each pull request Towercab opens for a ticket's intent is linked on the ticket.

- When the code PR is opened, Towercab adds one comment on the ticket with the PR link (a second
  comment only for a different PR, never twice for the same one), found by a hidden marker with the PR URL.
- A failed link never stops the pipeline: it is logged and retried on a later pass.
- Verified by: `jira: the code PR is linked on the ticket`, `jira: a PR is linked once`, `jira: a failed link does not stop the mission`

### JIRA-9 · The ticket key in branches and titles

When an intent has a ticket key, the key is in its branch name and is the scope of the code PR's title and commits.

- Branch `towercab/<id>-<KEY>-<slug>` instead of `towercab/<id>-<slug>`; every rule that matches
  `towercab/` still holds (PIP-2, cleanup).
- Title, commits and the squash merge of the code PR: `<type>(<KEY>)!: <subject>`, for example
  `feat(ABC-123): export invoices`. The key replaces the scope the design returned. The spec and plan
  PRs keep `docs(specs):` and `docs(plan):`, and the PR bodies carry the key as a link.
- The key must match `[A-Z][A-Z0-9_]+-[0-9]+` to be used; anything else is left out of branches and titles.
- Without a `jira:` field everything is as before.
- Verified by: `jira: the key is in the branch name`, `jira: the key is the scope of the code PR title`, `jira: commits use the key as scope`, `jira: an intent without a key keeps its branch and titles`, `jira: a malformed key is left out`

### JIRA-10 · No status changes

Towercab never moves a ticket to another status; the team's workflow decides that.

- The only calls Towercab makes that write to Jira are comments (JIRA-6..8). No transition, assignment,
  field edit or label change is ever sent.
- Verified by: `jira: only comments are written to Jira`

### JIRA-11 · Tests use a fake Jira

Everything about Jira is tested against a fake Jira that speaks HTTP, never the real service.

- `tests/helpers/` has a fake Jira server on a local port that implements the search, comment-list and
  comment-create calls, checks the basic-auth header, records every request, and fails a test on any
  call outside those, so JIRA-2 and JIRA-10 are checked on the wire.
- Verified by: `jira: the fake refuses a call outside the search and comment endpoints`

## Out of scope

Status transitions, assignment, and any change to a ticket other than comments. Tickets closed in Jira
dropping their intent (INT-28 is for issues only). Several Jira sites. OAuth, and Jira Server's older
API. Reading ticket comments, attachments or linked tickets.

## Decisions

- The key is the scope in titles rather than a suffix, so teams' Jira smart commits and Conventional
  Commit tooling both see it, and `type` keeps its meaning.
- Spec and plan PRs keep their `docs(...)` scope because other steps recognise them by it (PIP-111).
- A ticket ambiguous between repos is skipped, not guessed, as a wrong repo costs a wrong PR.
