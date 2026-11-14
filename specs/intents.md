# Intents

**Status:** Live: INT-1..44, INT-51..53, INT-60..68, INT-76..77 · **Prefix:** INT

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
  `## Towercab`, `## Answers` (INT-15) and `## Original title` (INT-34). Only `repo` and the title are
  required.
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

Removed: not used in v1 (no drafts were ever made). Issues now arrive as intent PRs the owner merges (INT-20..29).

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

### INT-23 · Proposing the intent from an issue

Towercab turns a scored issue into an intent pull request on the intents repo; nothing from an issue
is worked on until the owner merges that PR.

- The intent file has `repo`, `u`, `i`, `a` (INT-24), `source: issue`, `issue: <issue URL>`,
  `started`, then the title, `## Problem` and `## Proposed outcome`. The two reasoning sentences go in
  the body under `## Towercab` and are not shown as a question.
- It is committed on the branch `issue/<repo>-<n>` from `origin/main`, from Towercab's own clone
  `<home>/issues` (never the store's checkout), and opened as the App's PR
  `docs(intents): add <id> <title>` against `main`. The body links the issue, gives the scores with
  their reasons, and says that merging accepts it and closing it says no.
- Merging the PR is the owner's yes ([INT-4](#int-4--accepted-means-on-main)): only then is the intent
  on `main` and picked. Towercab never merges these PRs itself, at any autonomy. The one exception is
  a `towercab:queued` label the owner set by hand on an issue with no intent (INT-61).
- The ID is handed out against `main`'s folders, the IDs in the titles of the other open
  `issue/*` PRs, and the ones handed out earlier in the same poll, so proposals made in the same
  minute never share an ID.
- A step re-run after a crash finds the PR by its branch and opens no second one.
- Verified by: `issues: an issue becomes one intent PR`, `issues: nothing from an issue reaches main before the owner merges`, `issues: proposals in the same minute get different IDs`, `issues: a crash before the comment does not write twice`

### INT-24 · Autonomy of an issue intent

An issue intent starts at a3, and the owner changes that with an `a1`..`a5` label on the issue.

- `a` = the issue's `a1`..`a5` label if exactly one is present, else `[intents].issue_a` (default 3;
  1–5). Several `a` labels → the lowest.
- Because `source` is `issue`, the effective autonomy is at most 4 whatever the label says
  ([AUT-13](autonomy.md)); a5 is kept for the owner's own intents.
- Verified by: `issues: a3 by default`, `issues: an a-label sets the autonomy`, `issues: a5 label stays at a4`

### INT-25 · Telling the issue it is proposed, then queued

Towercab comments on the issue when the intent PR is open, and again once the owner has merged it.

- When the PR is open: a comment links the PR and says it waits for the owner's approval, then the
  label `towercab:proposed` is added.
- Once the intent is on `main`: a comment gives the intent's link, `u` and `i` with their reasons,
  and its place in the queue ([PRI-4](priority.md)), then the label `towercab:queued` is added.
- Both are written in the [writing guide](../prompts/writing.md)'s style, with no internal vocabulary.
  One comment of each kind per issue: the label stops a second one, and a failed comment is retried
  without a second PR or intent (INT-26).
- Verified by: `issues: the proposed comment links the PR`, `issues: the queued comment names scores and place`, `issues: an issue is commented once`

### INT-26 · One intent per issue, ever

Each issue becomes at most one intent, even after that intent is done or dropped.

- Dedupe on the `issue:` field across open intents, `done/` and dropped ones, and on any PR from the
  branch `issue/<repo>-<n>`, open, merged or closed. A match skips the issue: a PR the owner closed
  unmerged is a no, and the issue is never proposed again. Removing the label `towercab:proposed` or
  `towercab:queued` does not make a new intent.
- An unreadable intent file (INT-11) whose text holds the issue's URL still counts.
- Exception: a merged PR whose intent file is gone does not block a labelled issue (INT-61); a closed
  one still does.
- Verified by: `issues: a done intent blocks its issue`, `issues: a dropped intent blocks its issue`, `issues: a closed intent PR is never proposed again`

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
- A closed issue labelled `towercab:proposed` whose intent PR is still open has that PR closed.
- Once the intent has started, closing the issue changes nothing; the code PR's `Fixes` line (INT-27)
  or the owner decides.
- Verified by: `issues: closing the issue drops an unstarted intent`, `issues: a started intent ignores a closed issue`, `issues: closing the issue closes its open intent PR`

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

### INT-33 · Naming an intent

An intent's title is a plain user story, so the owner knows which product it is about and what
changes for its users when switching in cold, without opening the file.

- The rule, as the intents repo's README states it ("Naming an intent"): one plain sentence of about
  6 to 14 words, no period at the end; it names the product, then what someone can do or see once it
  is done, and for whom if it isn't the owner; no file names, functions, flags, stage names or
  jargon. "Towercab tells me on Telegram when it is stuck or broken", not "Self-monitoring in
  Towercab v2".
- The owner names their own intents. Anything else that writes an intent (an issue, a review, an
  agent's finding) names it by this rule, and Towercab renames it at pick when it doesn't (INT-34).
- Verified by: `prompts: every agent that writes for the owner asks for a plain brief`

### INT-34 · Intents from elsewhere are renamed at pick

When Towercab picks up an intent the owner didn't write, it gives it a plain title by INT-33 and
keeps the old one; the owner's own titles are never changed.

- The design returns `title` ([PIP-109](pipeline.md)). When the intent's `source` is set and isn't
  `me`, the title differs, and the intent has no `## Original title` yet, Towercab writes in one store
  commit (`towercab: rename <id>`): the old title as `## Original title` (`setSection`), and the new
  one, cleaned and checked as INT-36 says, on the title line (`setTitle`: only the first `# ` line
  changes, its `Intent: ` prefix and line ending kept; every other line stays byte-identical). Its
  feature-list line follows (INT-36). It runs before the spec is committed; a replay after a crash
  renames nothing twice, and finishes the feature line if that was cut off. A failed write is only
  logged.
- `source: me` or no `source`: the title is never changed.
- Verified by: `pipeline: an intent from elsewhere takes a plain title at pick`, `pipeline: the owner's titles are never renamed`, `intents: a rename changes only the title line`

### INT-35 · Towercab writes intents with plain titles

The intents Towercab writes itself follow the naming rule.

- Issue intake (INT-22, INT-23): `agents/score.md` asks for the title as a user story by INT-33,
  naming the product (`{{product}}`, the repo's short name), under 100 characters; the title is
  cleaned as INT-36 says (`plainLine`, at most 100). No other writer in Towercab creates intents;
  standards reviews and findings that arrive as intent PRs follow the README's rule, and INT-34
  renames them at pick if they don't.
- Verified by: `issues: the scorer names the work as a user story about the product`

### INT-36 · An agent's title is cleaned and checked before it is used

A title an agent writes can't carry markup, mentions or hidden characters into the intent, PRs,
commits or messages, and one that breaks the naming rule isn't used; a rename also updates the
intent's line in the repo's feature list.

- `plainLine(s, max)` (`src/intents/naming.ts`): printable characters only; HTML comments removed;
  no `<`, `>` or backticks; no `@` before a name; no leading `#`, `-`, `*` or `@`; one line, no
  trailing period; cut at a word boundary to `max` (100 for titles). `titleProblem` refuses fewer
  than 4 or more than 20 words: the rename is skipped with the log line `<id>: kept its title: the
  design's (<why>) doesn't follow the naming rule`.
- The renamed intent's line in `features/<repo>.md` (the one tagged `<!-- intent <id> -->`) takes the
  new title through `editFeatures` (`renameFeature`), when its text is still the old title as Towercab
  wrote it; its marker, status word, spacing and tag, and every other line, stay byte-identical. A line
  the owner reworded keeps their words. A failure is only logged.
- Verified by: `naming: agent text becomes one plain line`, `naming: a title outside the naming rule's length is refused`, `pipeline: a design title is cleaned before it renames`, `pipeline: a title that breaks the naming rule is not used`, `pipeline: a renamed intent's feature line takes the new title`, `features: a renamed intent's line takes the new title`

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

### INT-41 · A lead repo and the other repos

An intent names one lead repo and, optionally, the other repos it changes.

- `repo` (INT-2) is the lead: the repo that holds the spec and the intent's PRs for the spec and the
  plan. `repos` is a new optional front matter field: a list of repo names (or one name) for the other
  repos, in the form `repo` has. It is read and written like `after` (`setField`/`removeField`, other
  lines stay byte-identical). Without `repos` the intent works in the lead alone and nothing below
  applies.
- Names are unique and none equals the lead. An intent with `repos` is a **multi-repo intent**.
- Verified by: `intents: repos lists the other repos`, `intents: repos is optional and a single name works`, `intents: repos keeps the other lines byte-identical`

### INT-42 · The other repos must exist

A multi-repo intent whose `repos` names a repo Towercab is not set up for is not started.

- Every name in `repos` must be a repo in the config (LOOP-8) and must pass the same readiness check as
  the lead (LOOP-70). Otherwise the intent is not picked and shows `bad repos: <names>` with the reason,
  like `bad after:` (LOOP-5); the owner fixes the file or the config.
- `repos` naming the lead or twice the same repo makes the file unreadable (INT-11).
- Verified by: `pick: an unknown repo in repos is not started`, `pick: a repo that is not ready holds the intent`, `intents: repos naming the lead is unreadable`

### INT-43 · The plan says what changes in each repo

The plan of a multi-repo intent has one part per repo and says in which order they merge.

- `plan.md` (PIP-46) gets a `## Repos` section with one `### <repo>` entry for the lead and for each
  repo in `repos`: what changes there, in plain words, and the repos that part waits on (the first
  merges before the second). The entries form an order with no cycles; the merge order is read from
  them. A repo in `repos` the plan gives no change to is dropped from the intent's parts with a
  sentence saying so; the lead always has a part.
- The order must be backward compatible: each part, with only the parts before it landed, works live
  without the later ones, because a failure rolls back only the failing part and the ones after it
  (LOOP-82). The plan says in one sentence per part why it is safe alone.
- A plan with a missing part, a repo that is not in the intent, or a cycle fails the plan check
  (PIP-46) and the planner is asked again, as for any bad plan.
- The review of the plan PR and of each code PR (PIP-5) checks that order: a part that would break the
  live app until a later part lands is a finding.
- Verified by: `review: a plan whose early part breaks without a later one is a finding`, `plan: a multi-repo plan has a part per repo`, `plan: a cycle in the merge order is refused`, `plan: a repo the intent does not name is refused`, `plan: a repo with no change is dropped from the parts`

### INT-44 · One intent is still one spec and three phases

A multi-repo intent has one spec and one pull request each for the spec and the plan, in the lead repo.

- The spec PR and the plan PR (PIP-50, PIP-51) are opened and merged in the lead repo only. Requirements
  for code in other repos are written in the lead's specs, so the owner reviews the whole feature in one
  place. If most of the change is elsewhere, the owner makes that repo the lead by editing `repo`
  before the spec phase starts; Towercab does not move the spec by itself.
- Only the code phase splits into one PR per repo (LOOP-78). The intent's `stage` stays `spec`, `plan`
  or `code` (INT-5) for the whole intent.
- Verified by: `pipeline: a multi-repo intent has one spec PR and one plan PR in the lead`, `intents: the stage is one for all parts`

### INT-51 · Proposed intents on GitHub

Towercab knows which open pull requests on the intents repo would add an intent, so none waits unseen.

- A proposed intent is an open PR against `main` of the intents repo (drafts included) whose changes
  include a new `<id>/intent.md` (INT-2). Plan PRs (PIP-21) and PRs that add no intent are not proposed
  intents. It is read from the PR, never from the checkout, which stays on `main` (INT-4).
- The PR is **acceptable** when it adds exactly one intent file and changes nothing else apart from
  the generated `TODO.md`/`DONE.md` (INT-6). Otherwise it is **GitHub only**: listed, with a link, and
  closed from Towercab but not accepted (INT-53).
- Read for each: PR number and URL, title, draft or not, author login, `createdAt`, head SHA, and for an
  acceptable PR the intent file at that SHA. The file is parsed like any intent (INT-2) but only for
  display: its text reaches no Claude run. A file that doesn't parse shows the PR with the reason and
  can be closed from Towercab or opened on GitHub, not accepted.
- Merging the PR is what accepts the intent (INT-4); an intent from an issue stays as INT-23 says.
- Verified by: `proposed: a PR that adds one intent is proposed`, `proposed: drafts are proposed too`, `proposed: plan PRs and other PRs are not`, `proposed: a PR with several intents or other files is GitHub only`, `proposed: an unreadable intent file is shown with its reason`

### INT-52 · What a proposed intent shows

A proposed intent shows what the owner needs to judge it: who sent it, how urgent it is, and where it would rank.

- `title` (the intent's first heading, without `Intent: `), `repo`, `u`, `i`, `a` as written, `source`
  (INT-2), the proposer (the PR author's login; for the App, `Towercab`), `waitingSince` (the PR's
  creation time), `draft`, the PR URL and the URL of the intent file at the head SHA.
- `priority` = [PRI-3](priority.md)'s score with missing scores counted as 3; `parked` when it is below
  `[intents].cutoff` (PRI-5), shown as "would be parked" instead of the number.
- Verified by: `proposed: priority and parked follow the scores`, `proposed: the proposer is the PR author`

### INT-53 · Accepting and closing a proposed intent

The owner accepts a proposed intent by merging its PR, or says no by closing it, from Towercab.

- **Accept**: only for an acceptable PR (INT-51) still open at the head SHA the card showed. A draft is
  first marked ready; then the PR is squash-merged, both as the owner (LOOP-38). Merged, the intent is
  on `main` and the next read picks it up (INT-4). Changed head, closed, merged or no longer acceptable
  → nothing happens and the reply says why (`<PR> changed since you looked: check it and try again`).
- **Close**: allowed on every proposed intent, GitHub-only and unreadable ones included, because closing
  can be undone by reopening the PR. Comments the owner's reason (default `Not going ahead.`), then
  closes the PR as the owner. A PR already closed or merged → nothing happens and the reply says so.
  The intent never reaches `main`, and Towercab does not propose it again unless a PR is reopened or
  a new one is opened.
- A GitHub failure is reported to the owner as it is, and nothing is retried silently.
- Verified by: `proposed: accept marks a draft ready and squash-merges`, `proposed: accept refuses a PR that changed`, `proposed: close comments the reason and closes`, `proposed: GitHub-only PRs can't be accepted`, `proposed: GitHub-only PRs can be closed`

### INT-60 · Labels are checked against the intents

On each issue poll Towercab checks that every issue labelled queued or proposed still has the intent, or the open proposal, the label promises.

- Each poll (INT-21) lists the open issues labelled `towercab:queued` or `towercab:proposed`. An
  issue **has an intent** when an intent file carrying its `issue:` URL exists in the intents repo's
  checkout of `main`: open, in `done/` or dropped (INT-26), or unreadable with the URL in its text
  (INT-11). A merged proposal whose file is no longer there is not an intent.
- An issue with an intent, or with an open intent PR on the branch `issue/<repo>-<n>` (a proposal
  waiting for the owner), is left alone. Otherwise: its latest intent PR closed without merging →
  INT-62; no PR, or only a merged one whose file is gone → INT-61.
- The check reads only; a GitHub or store read that fails makes the poll skip it and try again on the
  next poll, so an incomplete list never counts as "no intent".
- Verified by: `issues: a labelled issue with an intent is left alone`, `issues: an issue with an open proposal is left alone`, `issues: a failed read skips the label check`

### INT-61 · A labelled issue with no intent gets one

An issue labelled queued or proposed that has no intent, and no closed proposal (INT-62), gets its intent written again: straight to `main` if the owner set the label, as a proposal otherwise.

- It goes through the steps of a new issue (INT-22, INT-23, INT-24), once per issue.
- **Label set by the owner**: the latest `labeled` event for `towercab:queued` on the issue has the
  actor `[github].me` ([LOOP-38](loop.md)). That is the owner's approval (INT-4): the intent file is
  committed to the intents repo's `main` from Towercab's own clone, as the owner's commits are accepted,
  with no proposal PR. The label stays `towercab:queued` and the queued comment (INT-25) is written
  once. A label set by anyone else, the App included, is not approval.
- **Otherwise**: a proposal PR is opened on `issue/<repo>-<n>` (INT-23) and the label becomes
  `towercab:proposed` (INT-25).
- When an earlier proposal PR of the issue was merged but its file is gone, the proposal body or the
  new comment says the earlier intent was lost; that merged PR does not block the issue (an exception
  to INT-26).
- Done once: the next poll finds the file or the open PR (INT-60), and a step re-run after a crash
  writes no second commit or PR.
- Verified by: `issues: a queued issue with no intent is proposed once`, `issues: an owner-labelled queued issue is written to main`, `issues: a queued label set by someone else is proposed`, `issues: a lost intent is proposed again and says so`, `issues: a crash does not write the missing intent twice`

### INT-62 · A closed proposal clears the label

When the owner closes an issue's intent PR without merging, the issue stops saying it is proposed or queued.

- An issue labelled `towercab:proposed` or `towercab:queued` with no intent (INT-60) whose latest
  intent PR is closed and not merged has the label removed and gets one comment saying the proposal
  was closed without merging and that Towercab will not propose it again (INT-26). The label is removed
  after the comment, so a failed comment is retried and a second poll writes nothing.
- An open or merged PR is not touched here.
- Verified by: `issues: a proposed issue whose PR was closed loses the label and is told`, `issues: a queued issue whose PR was closed loses the label and is told`, `issues: a closed-PR comment is written once`

### INT-63 · Which GitLab issues are read

For a GitLab repo, Towercab reads an open issue only if the owner wrote it or labelled it `towercab`, and never reads a confidential one.

- Applies to every `[repos]` repo hosted on GitLab (the host support of #129). Eligible: the issue's
  author is the owner's GitLab user, or the label `towercab` is on the issue, exactly as INT-20 says
  for GitHub. Any other issue is never read: its title, description and labels reach no Claude run, no
  log and no file.
- Confidential issues are skipped whoever wrote them: the owner's own and labelled ones too, because
  the intent text lands in an intents repo that more people may see than the issue. The check uses the
  `confidential` flag of the list answer, so the title, description and labels of such an issue reach
  no Claude run, no log and no file. The owner can file that work as an intent file or with the
  `/intent` skill.
- Merge requests are not issues and are skipped.
- Verified by: `gitlab issues: the owner's issue is eligible`, `gitlab issues: a towercab label makes another author's issue eligible`, `gitlab issues: an unlabelled issue by someone else is never read`, `gitlab issues: a confidential issue is never read`

### INT-64 · The GitLab issue poll

The loop looks for new eligible GitLab issues every 5 minutes, together with the GitHub ones.

- The poll (INT-21) lists the open issues of each GitLab repo through the GitLab API as the identity
  from #129, on the same 5-minute schedule and at start. The list carries no title or description; it is
  filtered by INT-63 before anything is read.
- A GitLab failure is a fault like a GitHub one ([LOOP-10](loop.md)): the poll is retried on the next
  pass, nothing is written for the issues it did not reach, and one repo failing does not stop the others.
- Verified by: `gitlab issues: the poll runs every 5 minutes`, `gitlab issues: a GitLab failure is a fault`, `gitlab issues: one failing repo does not stop the others`

### INT-65 · Labels on a GitLab project

The labels `a1`..`a5`, `towercab:proposed`, `towercab:queued` and `towercab:failed` work on a GitLab issue as on GitHub, and Towercab creates the ones the project lacks.

- Meaning and rules are those of INT-24 (autonomy label, several → lowest, effective cap 4), INT-22
  (`towercab:failed`) and INT-25 (`towercab:proposed`, `towercab:queued`).
- A missing label is created in the project before it is first set. Creating it twice, or finding it
  already there, is not an error. Existing labels are never changed or deleted.
- Verified by: `gitlab issues: an a-label sets the autonomy`, `gitlab issues: missing labels are created in the project`, `gitlab issues: an existing label is left alone`

### INT-66 · Notes on a GitLab issue, and closing it

Towercab tells a GitLab issue it is proposed and then queued with a note, and closing the issue before the intent starts drops the intent.

- The proposed and queued comments of INT-25 are notes on the issue, in the same words and style, once
  each; the label stops a second one and a failed note is retried without a second proposal.
- Closing an issue before the intent has a `stage` drops the intent with the note `issue closed`, and a
  `towercab:proposed` issue whose intent PR is open has that PR closed, as INT-28 says; once the
  intent has started, closing the issue changes nothing.
- Verified by: `gitlab issues: the queued note names scores and place`, `gitlab issues: an issue is noted once`, `gitlab issues: closing the issue drops an unstarted intent`, `gitlab issues: a started intent ignores a closed issue`

### INT-67 · The merge request closes the GitLab issue

Merging the code merge request closes a same-project issue, and links an issue from another project without closing it.

- When `issue:` points to an issue in the same project as the code change, the description built in
  `src/pipeline/prtext.ts` has the line `Closes #<n>`.
- An issue in another project is written as its full reference `group/project#<n>` with no closing
  word, so merging does not close it.
- Verified by: `prtext: a same-project GitLab issue gets Closes`, `prtext: another project's GitLab issue is linked by full reference`

### INT-68 · A GitLab issue follows the GitHub flow

A GitLab issue is scored, proposed as an intent PR, deduplicated and label-checked the same way a GitHub issue is.

- INT-22, INT-23, INT-26, INT-29 and INT-60..62 hold with the GitLab issue's URL in `issue:`, and the
  intent's `source` is `issue`. The scoring run gets only the title, description and labels.
- Proposals go wherever the intents repo is hosted, which is GitHub today: the proposal is a GitHub
  pull request on the intents repo (INT-23), never a GitLab merge request, and no GitLab-hosted
  intents repo is built here. Moving the intents repo is a separate intent.
- A GitHub and a GitLab issue never share an intent, because dedupe is on the full `issue:` URL.
- Verified by: `gitlab issues: an issue becomes one intent PR`, `gitlab issues: a done intent blocks its issue`, `gitlab issues: a labelled issue with no intent is proposed once`, `gitlab issues: the scoring run gets no tools`

### INT-71 · One writer for a new intent

The page and `towercab add` create an intent through the same function, and what it writes is what a hand-written intent would be.

- One function (`createIntent`, `src/intents/create.ts`) takes `{repo, title, u?, i?, a?, problem?, outcome?, affected?, constraints?, questions?}` and writes `intents/<id>-<slug>/intent.md` with the ID and slug of INT-3. Front matter: `repo`, then `u`, `i`, `a` only when given, `source: me`, `started` (now, local offset), as INT-2 describes for `add`; a score left at its default is not written. The body is a blank line, `# Intent: <title>`, then one `## <section>` for each text that is not blank, in the template's order (`Problem`, `Proposed outcome`, `Affected users and systems`, `Constraints`, `Open questions`); the text is kept as typed.
- The caller says who writes: `mode: "direct"` for the owner and for a maintainer of the repo (with `[auth]`, USR-5; without it, the one owner), `mode: "proposal"` for a contributor. A direct write is one commit to `main` of the intents repo, pushed like any edit of the owner's (INT-4, INT-24 replay on a rejected push); the generated views (INT-6) follow as they do for a hand-written intent. A failed push leaves no folder behind and reports the reason.
- A proposal writes the same file with `source: proposal` instead of `source: me`, and it does not reach `main`: it goes on a branch `proposal/<id>` in Towercab's own clone, opened as the App's pull request `docs(intents): add <id> <title>` (INT-23's way, with its ID rule: handed out against `main`'s folders and the IDs of open proposal PRs). The body names the contributor's login and says that merging accepts it and closing it says no. A maintainer accepts or closes it as INT-51..53 say; Towercab never merges it. A proposal's `a` is at most 4 (AUT-13). A step re-run after a crash finds the PR by its branch and opens no second one.
- `towercab add "<repo>: <title>" [uN] [iN] [aN]` calls this function with `mode: "direct"` and no sections and prints what INT-2 says; it is no longer a second writer. A later store for intents (an open intent PR, "Intents in a database for the hosted service") changes this function only.
- Verified by: `intents: createIntent writes the same file as a hand-written intent`, `intents: createIntent writes only the sections given`, `intents: createIntent leaves default scores out`, `intents: createIntent commits to main and pushes`, `intents: a failed push leaves no folder`, `intents: add goes through createIntent`, `intents: a contributor's intent is a proposal PR with source proposal`, `intents: a proposal never reaches main before it is merged`, `intents: a proposal's autonomy is capped at a4`, `intents: a crash before the PR comment opens no second proposal`

### INT-72 · An intent is checked before it is written

What the owner is about to write is checked as written: the repo must be one of Towercab's, the title is never rewritten, and the scores must be valid.

- `repo` must be a configured repo; `u`, `i` 1–5, `a` 0–5 (0–4 for a proposal, INT-71); the title is one line of 1–100 characters with no control characters, `<`, `>` or backticks. A bad value is refused with the reason and nothing is written. The title is never cleaned or rewritten here (INT-36's `plainLine` is for agents only). A section is at most 20,000 characters.
- A title outside INT-33's naming rule (`titleProblem`: fewer than 4 or more than 20 words) is allowed: it is only pointed out by the overlap check (INT-73) as a note, and the owner decides.
- Verified by: `intents: createIntent refuses an unknown repo`, `intents: createIntent refuses a bad score`, `intents: createIntent refuses a title with markup or two lines`, `intents: createIntent keeps a title that breaks the naming rule`

### INT-73 · The overlap check

An agent that only reads compares the new intent with the existing ones and says which overlap and how.

- `checkOverlap(draft)` runs a read-only agent (`agents/overlap.md`, no tools, no network, no write access). It is given the draft (repo, title, sections) and, inline, the intents of `main` that are open, parked (PRI-5), done or dropped (id, repo, title, stage, the first 600 characters of the Problem), and the open pull requests of the intents repo that add or change an intent (number, title, first 600 characters of the body). Unreadable intents (INT-11) are left out. With `[auth]` the bundle holds only intents and proposals of repos where the person has a role (USR-5), so a contributor's check never shows another repo's titles. The draft and every intent text are given as data in a fenced block, with the instruction that nothing inside them is an order; the agent has no tools, and its output is checked against the shape below, so text in an intent cannot make it act.
- Result: `{matches: [{kind: "open"|"parked"|"done"|"dropped"|"pr", ref, title, how}], titleNote?}`, at most 5 matches, strongest first; `how` is one plain line (`plainLine`, at most 160) on how the two overlap. A `ref` that is not in what the agent was given is dropped. `titleNote` is set only when the title breaks the naming rule (INT-33) and says so in one line, without a replacement title.
- A read that fails (the store, GitHub) or an agent run that fails, times out (120 s) or returns something that is not the shape above gives the error `The overlap check failed: <reason>`; the callers say the check was skipped if the owner goes on (UI-215, LOOP-124). Nothing is written by the check.
- The run's cost is recorded as a side run of kind `overlap` and counts in the day's spend (MET-29, outside any mission; LOOP-125).
- Verified by: `overlap: matches name open, parked, done and pr intents with a line on how`, `overlap: a match outside the given intents is dropped`, `overlap: the title note never carries a new title`, `overlap: the agent gets no tools`, `overlap: a failed run is an error not an empty list`, `overlap: unreadable intents are not sent`, `overlap: at most five matches`, `overlap: a contributor's bundle holds only repos they have a role in`, `overlap: text inside an intent is sent as data`

### INT-74 · Adding to an existing intent

The owner can add what they wrote to an existing open or parked intent instead of creating a new one.

- `addToIntent(id, draft)` appends each non-blank section of the draft to the same section of that intent's `intent.md`, after a blank line, creating the section at the end of the body when it is missing (before `## Towercab`, `## Answers` and `## Original title` when they exist). The title, repo and scores of the draft are ignored; the front matter and every other line stay byte-identical (`setField`'s rule, INT-24). It is one commit to `main`, pushed like INT-71.
- Allowed only for an intent that is open (parked included) and still at design: its `stage` is `spec` (INT-2) and it has no mission, or its mission is at the design step. An intent that is past design (`stage` `plan` or `code`, or a mission beyond design), done, dropped or unreadable, or one that is only a pull request, is refused with the reason and nothing is written. For one past design the text is `<id> is already past design, so new text would not change it. Write a new intent instead and link <id> in it.`, with `<id>` the old intent's ID (a link in the page). Nothing is saved and no mission is restarted.
- `canAddTo(intent)` in code (not the agent) decides this, so the form and `add` offer "add to this one" only where it will be accepted. Only a direct writer (INT-71) may add: a contributor's proposal cannot edit an intent on `main`.
- The addition is on the intent's timeline (who, through which channel).
- Verified by: `intents: addToIntent appends to the matching sections`, `intents: addToIntent creates a missing section before the Towercab sections`, `intents: addToIntent leaves the front matter alone`, `intents: addToIntent refuses a done intent`, `intents: addToIntent refuses an intent past design and says to write a new one`, `intents: addToIntent refuses a contributor`, `intents: an addition is on the timeline`

### INT-75 · A covered intent keeps its feature line

An intent closed as covered by another keeps its line in the feature list, marked with the intent that covered it.

- Replaces INT-38's removal for this case only: entering `done` by `covered_by` (LOOP-156) keeps the line and appends `(covered by <id>)`, the ID linked as `DONE.md` links it (INT-6). The status is `live` once the covering intent's line is live and `in progress` before, and the line follows the covering line from then on. The owner's wording stays; only the status word and the mark change (INT-37).
- When the covering intent is dropped or stopped (LOOP-158), the covered intent stays done and its line goes back to its own wording, without the covered mark, as `- [planned] <sentence> (not delivered) <!-- intent <id> -->`; it is not removed. If the covering intent later ends done again (a reopen that finishes), the line is marked covered again.
- `reopen` (LOOP-157) removes the mark and restores the status the line had before the cover; a `(not delivered)` line becomes `in progress`. Entering `stopped` still removes the line (INT-38).
- Verified by: `features: a covered intent keeps its line marked covered by the other`, `features: a covered line follows the covering intent's status`, `features: reopen restores the feature line`, `features: a dropped covering intent marks the line not delivered`

### INT-76 · An intent has a kind

An intent can say what kind of work it is, and the kind decides how much of the full path it goes through.

- `kind` is an optional front-matter key, written by the owner or from the page (UI-283): `bugfix`, `refactor`, `infra` (infrastructure and configuration), `feature` or `spec-only` (a change that lives only in the specs and the repo's settings files, or only in steps the owner does). Any other value is a field error and the intent is unreadable (INT-11).
- Missing means "not set": Towercab infers one (INT-77). A set `kind` is never changed by Towercab; it is only written with `setField` (INT-5), so the other lines stay byte-identical.
- The paths of the kinds are PIP-228..PIP-232.
- Verified by: `intents: kind is one of five values`, `intents: an unknown kind makes the intent unreadable`, `intents: setting kind keeps other lines`

### INT-77 · Towercab infers the kind when the owner has not set it

When an intent has no kind, Towercab reads it once and picks one, and the owner can see why and change it.

- At the first step of the design stage, a mission whose intent has no `kind` runs the `kind` agent (no tools, `[agent].model`; its cost counts in the mission): it gets the intent text as data and returns `{kind, why}` (`why` is one plain line, at most 160 characters). The result is kept in the mission (`data.kind`, `data.kindWhy`); the intent file is not edited. A failed or invalid run counts as `feature`, the full path, and is noted on the timeline.
- Doubt goes to the full path: the agent is told to answer `feature` unless the intent clearly fits a lighter kind. A `kind` set in the intent always wins over the inferred one, and a change from the page (UI-283) is written to the front matter and replaces it.
- The code PR that builds this adds `agents/kind.md` and its row in the agents table of `pipeline.md` (PIP-76) together, since the spec check requires the table and the agent files to match.
- A guessed kind takes effect at once: nothing waits for the owner to confirm it. The first PR of the mission (the plan PR for `bugfix`, `refactor` and `infra`, the spec PR for `spec-only`) says in plain words which kind was guessed and why, and that one reply switches it.
- One reply switches the kind: the owner's comment on that PR `kind: <value>` (PIP-44, PIP-45), or the page (UI-283). Towercab writes `kind` to the intent (INT-76) and puts the mission on that kind's path (PIP-228) at the next stage that has not started; a mission already past a stage the new kind needs goes back to it (for `feature`, to design, PIP-231). A comment from anyone else is ignored as in PIP-44.
- A guess never lowers the review: a change the risk agent judges high (PIP-96) is held for the owner at its gates whatever the kind, as PIP-232 says.
- Verified by: `kind: the agent gets the intent as data and no tools`, `kind: a set kind skips the agent`, `kind: a failed run counts as feature and is noted`, `kind: the inferred kind and its reason are kept in the mission`, `kind: a guessed lighter kind takes effect without waiting`, `kind: the first PR says the guess and its reason`, `kind: one reply from the owner switches the kind and its path`

## Out of scope

- Other stores (Notion, Jira).
- Confidential GitLab issues, including the owner's own (INT-63).
- An intents repo hosted on GitLab (INT-68).
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
- Issues become intent PRs, not commits to `main` (2026-11-04): an issue written under the owner's
  login, or labelled by anyone with triage access, is not the owner's considered yes, and Towercab's
  scored rewrite is worth reading before work starts. Merging is the same yes the owner already gives
  plans and machine-written intents (INT-4).
