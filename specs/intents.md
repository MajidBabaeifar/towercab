# Intents

**Status:** Live · **Prefix:** INT

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

Removed: not used in v1 (no drafts were ever made). Issues now go straight onto the queue (INT-20..29).

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

### INT-20 · Which issues are read

Towercab reads an open issue only if the owner wrote it or labelled it `towercab`; every other issue is ignored unread.

- Watched: the open issues of every `[repos]` repo. Eligible: `author.login == [github].me`, or the
  label `towercab` is on the issue. Issues by anyone else without that label are never read: their
  title, body and labels reach no Claude run, no log and no file.
- Pull requests are not issues and are skipped.
- Verified by: `issues: the owner's issue is eligible`, `issues: a towercab label makes another author's issue eligible`, `issues: an unlabelled issue by someone else is never read`

### INT-21 · The issue poll

The loop looks for new eligible issues every 5 minutes.

- `src/github/issues.ts` lists each repo with `gh issue list --state open --json …` as the App, from
  the loop (`src/loop.ts`) at most once per 5 minutes of the loop's clock (also on start).
- A GitHub failure is a `github` fault like any other ([LOOP-10](loop.md)): the poll is retried on
  the next pass and nothing is written for the issues it did not reach. One repo failing does not
  stop the others.
- Verified by: `issues: the poll runs every 5 minutes`, `issues: a gh failure is a github fault`

### INT-22 · Scoring an issue

A short Claude run with no tools reads the issue and proposes its scores, title and sections.

- Input: only the issue's title, body and labels. No tools, no repo access, no other context.
- Output, checked against a JSON schema: `u` and `i` (1–5) each with one sentence of reasoning, a
  clear `title`, and the `problem` and `outcome` texts (the Problem section and the Proposed outcome
  bullets, INT-2).
- A result that fails the schema is retried once. If the retry also fails, Towercab comments on the
  issue asking the owner to write the intent by hand, adds the label `towercab:failed`, and does not
  poll that issue again until the label is removed.
- Verified by: `issues: the scoring run gets no tools`, `issues: a bad score result is retried once`, `issues: two bad results ask the owner to write it by hand`

### INT-23 · Writing the intent from an issue

Towercab turns a scored issue into an accepted intent in one store commit, with no pull request first.

- One `Store.add` ([INT-12](#int-12--the-store)) writes `repo`, `u`, `i`, `a` (INT-24), `source: issue`,
  `issue: <issue URL>`, `started`, then the title, `## Problem` and `## Proposed outcome`. The two
  reasoning sentences go in the body under `## Towercab` and are not shown as a question.
- The issue is the owner's request, so the intent is on `main` at once (INT-4 holds: the commit is
  pushed to `main`). Lowering `u`/`i` or closing the issue (INT-28) is how the owner says no.
- A mark trailer (`issue:<url>`, [INT-12](#int-12--the-store)) keeps a step re-run after a crash from
  writing twice.
- Verified by: `issues: an issue becomes one intent commit`, `issues: a crash before the comment does not write twice`

### INT-24 · Autonomy of an issue intent

An issue intent starts at a3, and the owner changes that with an `a1`..`a5` label on the issue.

- `a` = the issue's `a1`..`a5` label if exactly one is present, else `[intents].issue_a` (default 3;
  1–5). Several `a` labels → the lowest.
- Because `source` is `issue`, the effective autonomy is at most 4 whatever the label says
  ([AUT-13](autonomy.md)); a5 is kept for the owner's own intents.
- Verified by: `issues: a3 by default`, `issues: an a-label sets the autonomy`, `issues: a5 label stays at a4`

### INT-25 · Telling the issue it is queued

Towercab comments once on the issue to say it is queued, and labels it so it is not read again.

- The comment gives the intent's link, `u` and `i` with their reasons, and its place in the queue
  ([PRI-4](priority.md)). Then the label `towercab:queued` is added. Written in the
  [writing guide](../prompts/writing.md)'s style, with no internal vocabulary.
- One comment per issue: an issue that already has `towercab:queued` is not commented again, and a
  failed comment is retried without a second intent (INT-26).
- Verified by: `issues: the queued comment names scores and place`, `issues: an issue is commented once`

### INT-26 · One intent per issue, ever

Each issue becomes at most one intent, even after that intent is done or dropped.

- Dedupe on the `issue:` field across open intents, `done/` and dropped ones. A match skips the issue.
  Removing the label `towercab:queued` does not make a new intent.
- An unreadable intent file (INT-11) whose text holds the issue's URL still counts.
- Verified by: `issues: a done intent blocks its issue`, `issues: a dropped intent blocks its issue`

### INT-27 · The code PR closes the issue

Merging the code PR closes the issue it came from.

- When `issue:` points to an issue in the same repo as the code PR, the PR body (`src/pipeline/prtext.ts`)
  has the line `Fixes #<n>`. An issue in another repo is linked by URL only, without `Fixes`.
- Verified by: `prtext: a same-repo issue gets Fixes`, `prtext: another repo's issue is only linked`

### INT-28 · Closing the issue drops the intent

If the owner closes the issue before Towercab starts the intent, the intent is dropped with a note.

- Each poll (INT-21) looks up the issue of every intent that has an `issue:` and no `stage` yet. If it
  is closed, the intent is dropped ([PRI-9](priority.md)) with the note `issue closed`, and the
  `towercab:queued` label stays.
- Once the intent has started, closing the issue changes nothing; the code PR's `Fixes` line (INT-27)
  or the owner decides.
- Verified by: `issues: closing the issue drops an unstarted intent`, `issues: a started intent ignores a closed issue`

### INT-29 · The issue on the intent page

The UI's intent page links to the issue an intent came from.

- The intent view model carries `issue` (the URL, or none); the page shows it as a link next to the
  source.
- Verified by: `ui: the intent page links its issue`

### INT-30 · A body that doesn't parse is unreadable

An intent whose body is not valid Markdown is listed as unreadable with the reason and the line, instead of having its sections read as empty.

- Parsing an intent (INT-2) also parses its body (`markdown::items` equivalent); a failure makes the
  file unreadable (INT-11) with the reason and the 1-based line in the file, for example
  `intents/<dir>/intent.md: unclosed code fence at line 18`. The line is where the fence opened.
- It shows in `status`, `next` and the UI's Intents page like any other unreadable file (INT-11), and
  `get`, `update` and the design step's open-question check ([PIP-25](pipeline.md)) fail with that
  reason, never with a count against empty sections.
- Section reads (`## Problem`, `## Proposed outcome` bullets, `## Open questions`) no longer return
  an empty list on a parse failure.
- Intents that parse today read the same: bodies with balanced fences, or none, are unchanged.
- Verified by: `intents: an unclosed code fence makes the intent unreadable`, `intents: the unreadable reason names the line`, `intents: a body that parses reads the same`, `pipeline: a broken body fails design with its reason`

### INT-31 · Drafts avoid fence markers

The `/intent` skill and the issue scorer write bodies that cannot be read as an unclosed code fence.

- `skills/intent/SKILL.md` and the scoring prompt (INT-22) tell the writer never to start a prose or
  bullet line with three backticks or three tildes; inline code uses single backticks, and a real code
  block is opened and closed on lines of its own.
- Verified by: `intents: the skill forbids fence markers in prose`, `issues: the scoring prompt forbids fence markers in prose`

### INT-32 · Issue intents keep who is affected, the constraints and the open questions

When an issue says who is affected, names a constraint or leaves something undecided, the intent
drafted from it keeps that in its own section, so the design starts from everything the issue said.

- **Schemas** `score` ([pipeline.md](pipeline.md)) gains `affected` (string, empty when the issue
  doesn't say), `constraints` (list of strings) and `open_questions` (list of strings).
  `agents/score.md` tells the scorer to take them from the issue only and never invent them: an issue
  that says nothing about them gives empty values. The fence rule (INT-31) covers them too.
- INT-23 writes `## Affected users and systems`, `## Constraints` and `## Open questions` (bullets)
  after `## Proposed outcome`, each only when it has content. The design answers the open questions
  as for any intent ([PIP-25](pipeline.md)).
- Verified by: `issues: the intent keeps affected, constraints and open questions`, `issues: empty sections are left out`

### INT-37 · A feature list per repo

Each repo has a short list, in the intents repo, of what people can do with it, which the owner can
read and edit by hand.

- `features/<repo>.md` (`<repo>` the `[repos]` name, INT-2's repo rule). A new file starts with
  `# <repo>: what people can do` and an HTML comment saying how to edit it. One feature per line:
  `- [live] <sentence>`, `- [in progress] <sentence>` or `- [planned] <sentence>` (`*` works as the
  marker, the status in any case). A line Towercab adds for an intent ends with
  `<!-- intent <id> -->`, which is how it finds the line again. Any other line (notes, headings,
  blanks) is kept as it is and never read as a feature.
- Written only through the store's `editFeatures(repo, what, fn)`: INT-10's protocol (lock, pull,
  change, regenerate the views, commit `towercab: features <repo> <what>`, push, replay after a
  rejected push); no change → no commit. A symlink in its path is refused (INT-1), as is a name that
  isn't a repo name. Towercab edits line by line: every line it doesn't change stays byte-identical.
- Read for the page through `localFeatures(repo)`: the local checkout's copy, without a pull or the
  lock (the loop's `list()` keeps the checkout fresh), so a page open while work runs doesn't sync the
  intents repo every few seconds, and the list still shows offline. Bytes that aren't UTF-8 are refused
  as `features/<repo>.md: not UTF-8`.
- Verified by: `features: lines parse with status and intent`, `intents: the feature list is written through the store`

### INT-38 · The list follows the intents

When Towercab starts an intent its line appears as in progress, when the intent is done it becomes
live, and when its work stops for good its line goes.

- In the loop's entry effects (LOOP-6), after the intent file's fields: entering `pick` sets the
  intent's line to `in progress`, adding `- [in progress] <title> <!-- intent <id> -->` after the last
  feature line when there is none; entering `done` sets it to `live` (added the same way when
  missing); entering `stopped` removes it, whatever stopped it (a drop, a closed PR, the intent file
  removed or moved), since a stopped intent is no longer being worked on and comes back as planned if
  it is queued again. A replaced attempt changes nothing: the new attempt's `pick` does. Only the status word of an existing line changes, so the
  owner's wording stays. The title is cleaned to one line of at most 200 characters.
- Each edit is idempotent, so an entry retried after a crash repeats it harmlessly. A sync failure
  retries the entry on the next pass; any other refusal (a symlink, bytes that aren't UTF-8) is
  logged and the mission moves on.
- Verified by: `features: a picked intent gets an in-progress line, other lines stay byte-identical`, `features: done marks the line live, keeping the owner's wording`, `features: a dropped intent's line is removed`, `features: the loop tracks an intent from pick to done`, `features: a dropped intent's line goes`, `features: an unreadable feature list doesn't hold a mission`

### INT-39 · Writing the list from the repo

When a repo has no list of its own yet, Towercab reads the repo's README and specs once and writes
down what people can already do; the owner can ask for it again.

- Asked for by the Repos page (UI-144): meta `features:<repo>` becomes `{state: "due"}`. The loop
  starts the oldest due one when new work may start (not paused, no blocking problem, under the daily
  budget), one at a time, on its own (`running`), and records `done` (with the count and cost) or
  `failed` (with the reason). A stop kills the run and makes it due again; one a crash left `running`
  is due again on the next start. While it runs the loop isn't idle, so neither a self-update
  (LOOP-35) nor `towercab run` without `--watch` ends it.
- The run: inside the pass (so it never fetches Towercab's clone beside a mission's git step), the
  clone is fetched and a fresh checkout of the base branch is made at `work/features-<repo>` (removed
  afterwards); then, on its own, `agents/features.md` runs there with `Read`, `Glob`,
  `Grep` only, in the sandbox, no network, `[agent].model`, `timeout_min: 10`, `max_cost_usd: 2`, its
  files under `runs/features/<repo>/`, and a run past its time limit fails. Its prompt gets the repo's
  name, the current live lines no intent added (`<current>`) and the live lines intents added
  (`<listed>`, not to be repeated), each fenced as data.
- The answer is data: schema `features` (`{features: string[]}`) is checked first; each sentence is
  cleaned to one line (no list marker, heading, status, HTML comment; at most 200 characters),
  duplicates and sentences already in `<listed>` dropped, at most 30 kept, none left → failed. The
  sentences replace the file's `live` lines that no intent added, at the place of the first one; such
  lines the owner added during the run (not among those in `<current>`) are kept after them; every
  other line stays.
- Verified by: `features: the backfill replaces only the untagged live lines`, `features: model text is cleaned to one sentence`, `features: the backfill reads the repo read-only and writes the live lines`, `features: a bad backfill answer is recorded, not written`, `features: the backfill is shown what intents already listed and doesn't repeat it`, `features: lines the owner adds during a backfill are kept`, `features: a backfill stopped by a shutdown is asked for again`, `features: a backfill that runs out of time fails`, `features: a backfill left running is asked for again on start`

### INT-40 · Planned features

Queued intents count as planned without being written to the file.

- The Repos page shows as planned the file's `planned` lines, then every up-next or waiting intent of
  the repo (UI-63) that no line names, by its title. Parked intents aren't planned. Towercab never
  writes a `planned` line; the owner may.
- Verified by: `ui: a repo page shows its features, work and spend`

## Out of scope

- Other stores (Notion, Jira).
- Intents drafted from monitoring alerts.
- Issues by other people without the `towercab` label (INT-20).
- The backfill's cost (INT-39) in the spend metrics: it runs outside any mission, so only its own
  status sentence shows what it cost; side runs' costs are a later intent.

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
