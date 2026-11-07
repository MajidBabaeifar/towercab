# Observer

**Status:** Draft · **Prefix:** OBV

## Purpose

The observer is a read-only agent that watches how Towercab runs and proposes improvements as
intents: a check that keeps failing, a stage that is always slow, costly runs, waits the owner always
answers the same way, cards the owner finds unclear. It replaces the parked self-monitoring of
[maintain.md](maintain.md). It serves the owner, who otherwise notices these patterns only by chance.

## Requirements

### OBV-1 · The observer only reads

The observer cannot change anything in Towercab or in any repo: it reads, and it writes only what OBV-4 allows.

- It runs as an agent step with no write access to any checkout, no `gh` or git credentials, and no
  network. It gets a prepared, read-only evidence bundle (OBV-3), never the live database or the
  clones. Its tools are read only.
- It cannot merge, approve, answer, start, drop or pause an intent, edit `config.toml`, a setting, a
  repo's `TOWERCAB.md` or any code. Its only outputs are the JSON result of OBV-4 and its own run record (OBV-12);
  Towercab's code, not the agent, turns that result into a proposal.
- Verified by: `observer: the agent runs without write access or network`, `observer: the agent gets no credentials`, `observer: only the result schema reaches Towercab`

### OBV-2 · When it runs

The observer runs once a day and after notable events, never more often than the rate limit allows.

- Daily at `[observer].daily_at` (local time, `HH:MM`, default `06:00`), counted on the loop's clock;
  a day missed while Towercab was off runs once at the next start.
- Notable events: an intent blocked on `worker budget` (LOOP-1), the same check red
  three times for one intent, a rollback (SHIP), and a spend cap reached (MET-33). Each event marks
  the observer due; due runs are merged, with at most one event run per hour and none while one runs.
- On by default. The config line `[observer] enabled = false` switches it off; no run starts while it
  is off, and a run already going finishes. The loop re-reads the keys each pass, so an edit applies
  without a restart. A pass never waits for a run (it is a background job as in LOOP-71).
- Verified by: `observer: it runs daily at the set time`, `observer: a missed day runs once at start`, `observer: a notable event makes it due`, `observer: event runs are at most one an hour`, `observer: on by default`, `observer: enabled false switches it off`

### OBV-3 · What it reads

The evidence bundle covers the last 14 days of how Towercab ran, and nothing else.

- Per run, intent and stage: runs and the end of their logs, costs (MET), how long each wait and each
  stage took, repairs and retries, red checks and their names, review findings, alerts and problems
  (UI-60), and the owner's replies, answers and decisions (accept, close, drop, approve) with the time they took.
- It covers every configured repo, with each repo's name and a one-line description (OBV-4).
- Built by code from the database and `runs/<id>/`, in a size limit (`[observer].bundle_kb`, default
  400), newest first; what is cut is named in the bundle. Secrets are removed as the guard does for
  other agent text, and the text of an intent is data, not instructions.
- Each item carries an id the agent cites: a run id, an intent id or a PR number.
- Verified by: `observer: the bundle covers fourteen days`, `observer: the bundle names what it cut`, `observer: secrets are removed from the bundle`, `observer: every item has an id to cite`

### OBV-4 · It proposes intents through the proposed-intents flow

Each improvement the observer finds becomes a proposed intent the owner accepts or closes like any other.

- The agent returns a list of `{title, repo, problem, outcome, evidence, gain, u, i, a, overlaps}`.
  For each, Towercab opens one pull request on the intents repo as the App (INT-51), with one new
  intent file: `source: observer`, `repo`, `u`, `i`, `a`, `## Problem` (with the evidence, OBV-5) and
  `## Proposed outcome` (with the gain). It then appears as every proposal does (INT-52, LOOP-93).
- **Any repo.** The observer picks the repo where the fix belongs, from the repos Towercab has
  configured (LOOP-67), not only `towercab`: a CI timeout goes to the `ci` repo, a flaky test to the
  repo that has it. The proposal's `repo` is that repo; the evidence may come from runs of other repos.
  The bundle (OBV-3) lists each repo's name and what it holds, so the agent can choose. A `repo` that
  is not configured drops the finding with the reason `unknown repo`; it is never replaced by a guess.
- The intent still goes to the one intents repo as a proposal (INT-51): the owner accepts or closes it as
  any other, whichever repo it is for. The observer sets no autonomy that skips that step.
- `a` is never above 4, the cap AUT-13 gives `source: shadow`, whatever the agent writes; the
  observer cannot write `source: me`. An intent with `source: observer` is capped the same way at pick.
- A closed proposal is a no (INT-53): the observer does not propose the same thing again unless it
  cites runs newer than the closing (OBV-6).
- Verified by: `observer: a finding becomes one proposed intent PR`, `observer: a CI finding is proposed for the ci repo`, `observer: a flaky test is proposed for the repo that has it`, `observer: a finding for an unknown repo is dropped`, `observer: the intent has source observer`, `observer: autonomy is capped at a4`, `observer: a closed proposal is not proposed again without new evidence`

### OBV-5 · Each proposal shows its evidence and its gain

A proposal says what it saw, links the runs, and says what it expects to gain; one without evidence is not proposed.

- `## Problem` ends with an `### Evidence` list of at least two links to runs, intents or PRs (UI
  links), each with one line on what it shows. `## Proposed outcome` ends with `### Expected gain`: a
  measurable claim with a number where there is one ("the same check failed in 6 of 9 runs; fixing it
  saves about 2 repairs per intent"). A cited id that is not in the bundle (OBV-3), or fewer than two
  citations, drops the finding and records why (OBV-12).
- The title follows the naming rule (INT-33), is cleaned and checked as INT-36 says, and at most 100 characters.
- Text a person reads follows `prompts/writing.md`: plain, outcome first, no Towercab jargon.
- Verified by: `observer: a proposal lists its evidence and expected gain`, `observer: a finding with fewer than two citations is dropped`, `observer: a cited id outside the bundle is dropped`, `observer: the title follows the naming rule`

### OBV-6 · It adds to an existing intent instead of duplicating

Before proposing, the observer checks the intents already there, and adds its evidence to one that covers the same thing.

- The bundle includes the title, repo and first lines of every open intent, every open proposal, and
  intents done or dropped in the last 30 days. The agent names `overlaps` (intent ids, or PR numbers) it
  found; Towercab also drops a finding whose title is the same as one of them after normalising case and punctuation.
- Overlap with an open proposal or an intent in its spec or plan stage: a comment with the new evidence
  on its pull request, as the App, and no new proposal. Overlap with an intent already building or done: the
  finding goes in the weekly report (OBV-8) as "seen again", with the links, and nothing else.
- A comment is made once per run per target. A comment that cannot be posted is retried at the next run, not silently dropped.
- Verified by: `observer: a finding that overlaps an open proposal adds a comment`, `observer: a finding that overlaps a running intent goes in the report`, `observer: an identical title is not proposed twice`, `observer: a comment is posted once per run`

### OBV-7 · A few proposals a week

The observer opens at most three proposals in any seven days.

- Limit `[observer].max_proposals_per_week` (integer 1–10, default 3), counted over a rolling 7 days
  from `observer_proposals` (OBV-12), closed ones included. When the agent returns more findings
  than room, the highest ranked (OBV-9) go first and the rest wait for the report as "also seen".
- Comments of OBV-6 do not count toward it.
- Verified by: `observer: at most three proposals in seven days`, `observer: the best ranked findings use the room`, `observer: comments do not count toward the limit`

### OBV-8 · A weekly report on Telegram

Once a week the owner gets a short message saying what the observer saw, even when it proposed nothing.

- Monday at `[observer].daily_at` (after that day's run), one outbox row keyed `observer:report:<ISO
  year-week>` so it is sent once (LOOP-14). Text, at most 12 lines: proposals opened this week with
  links to their cards, findings held back (OBV-7), things seen again (OBV-6), observer spend this
  week, and "nothing notable" when so. Plain words, as `prompts/writing.md` asks.
- Nothing is sent while the observer is off. A failed report is retried by the outbox (LOOP-14).
- Verified by: `observer: a weekly report is sent once`, `observer: the report is sent when nothing was found`, `observer: the report lists proposals and held findings`, `observer: no report when off`

### OBV-9 · It ranks by the owner's steering

When the owner has written down goals and direction, the observer ranks its findings by them.

- Towercab passes the steering text to the agent in the bundle when it exists, and tells it to put
  findings that serve the stated goals first and to set `u` and `i` with them in mind. Without a
  steering text it ranks by evidence alone: how often it happened, time and money lost.
- The steering is read, never written, by the observer. How and where it is stored belongs to the
  intent that creates it; until then the read returns nothing.
- Verified by: `observer: the steering text is in the bundle when present`, `observer: without steering it ranks by evidence`

### OBV-10 · Its cost counts, with a cap

The observer's runs are part of the spend and have their own daily cap.

- Each run's cost is kept on its record and added to the day's spend as MET-29 does for runs, labelled
  `observer`, so it counts toward the overall budgets as MET-32 says for the shadow, and for no repo. When
  today's observer cost reaches `[observer].daily_budget_usd` (default 3), no further run starts that day; a run
  going is limited to what is left of the cap. Reaching it pauses nothing else, and the overall budget (MET-33) still applies.
- One run is also bounded by `[observer].max_budget_usd` (default 1.5).
- Verified by: `observer: its cost is in the spend`, `observer: the daily cap stops further runs`, `observer: the cap does not pause picks`, `observer: a run is bounded by its own budget`

### OBV-11 · It never changes Towercab by itself

The only things the observer's code does are open proposals, post comments with evidence, and send the report.

- These three are the whole list: a proposal PR (OBV-4), an evidence comment (OBV-6), a report row (OBV-8).
  No merge, no ready-marking, no close, no setting, no code PR and no intent edit on `main`. A proposal
  PR that the observer opened is not touched again by it, except for a comment.
- A test fails if the observer module calls any `Forge` or `Tools` method beyond opening a PR and
  commenting.
- Verified by: `observer: it opens, comments and reports and does nothing else`, `observer: it never merges or edits an intent on main`

### OBV-12 · Every run is recorded

Each observer run is kept with when it ran, why, what it cost and what came of it, and a failure never stops the loop.

- Table `observer_runs`: id, `trigger` (`daily`, or the event), start and end, cost, outcome (`done`,
  `failed`, `capped`), counts of findings, proposals, comments and dropped findings with the reason of
  each. Table `observer_proposals`: PR number, intent id, run id, time. Kept 90 days.
- A failed run (agent error, an unreadable result, a GitHub failure) is a fault of the loop (LOOP-10)
  of kind `observer`, is retried at the next trigger, and moves no mission. A result that does not match the schema counts as failed
  and opens nothing. A crash mid-run opens no second PR: the branch is `observer/<run id>-<n>`, so a replay finds it.
- Verified by: `observer: a run is recorded with its cost and outcome`, `observer: a failed run is a fault and does not stop the loop`, `observer: an invalid result opens nothing`, `observer: a replay after a crash opens no second PR`

## Out of scope

- Acting on what it sees: the owner accepts a proposal, and the pipeline builds it like any intent.
- Changing the owner's settings, budgets or priorities.
- The steering text itself: its own intent defines it.
- Watching the target repos' own production (that is [ship.md](ship.md)).

## Decisions

- It replaces the parked self-monitoring (intent 261026-2204-2): fixed bands need weeks of data and
  never fired, while an agent reading the evidence can say why something is slow and what to change.
- It is on by default, because an observer the owner must remember to start would not notice what the
  owner does not notice; its small cap and the proposal step bound what it can cost or do.
- It proposes for any repo, because the fix for a symptom often lives elsewhere than where it showed.
- Findings become intents, not changes, so the owner stays the only one who decides what is built.
- At most three proposals a week and two cited runs each, so the owner's inbox stays readable and a
  proposal can be checked.
- `a` is capped at 4 as for the shadow: an agent's idea should not run unattended to a merge.
