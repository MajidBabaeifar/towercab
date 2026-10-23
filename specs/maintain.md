# Maintain

**Status:** Live: MNT-1..8 · **Prefix:** MNT

## Purpose

Stage 6 of the playbook, closing the loop: deterministic code watches Towercab's own process
metrics; a breach is diagnosed by Claude and comes back as an intent I triage.

## Requirements

| ID | Requirement | Verified by |
|---|---|---|
| MNT-1 | **Bands** live in `ops/bands.yaml` in the Towercab repo (protected, [REPO-6](repo.md); changed by PR), the playbook's shape (**Bands**), read each round from Towercab's clone (`git show refs/remotes/origin/<base>:ops/bands.yaml`; the `[repos]` repo `evals::towercab_repo` finds) and parsed with `yaml-rust2` (`bands::parse`): per band `metric` (a **Names** name, [metrics.md](metrics.md), without `towercab.`), `query` (PromQL against `[metrics].prometheus`, one series), `period` (`<n>h\|d\|w`, default `1d`), `baseline` (`rolling_<n>d`, default `rolling_30d`, ≥ 22 periods), `rules: western_electric` (the only value, the default), `side` (`high`, `low`, `both`: the default), `min_shift` (a number ≥ 0, absolute units, default 0), optional `repo` (the alert intent's and `cap_repo`'s; default the Towercab repo), and `tiers` `1sigma`, `2sigma`, `3sigma`, each `{action: log\|diagnose\|propose, routes: [pull_request, runbook:cap_repo, runbook:pause]}` (`routes` only with `propose`; a tier left out = the playbook's: `log`, `diagnose`, `propose` with `[pull_request]`). Any error (unknown key, bad value) → `ops/bands.yaml: <band>: <reason>`, logged once, no band evaluated; no file or no Towercab repo → no bands. | test_parse_bands |
| MNT-2 | **Default bands** (Towercab's process only; `ops/bands.yaml` = **Default bands**): MET series by the dashboard's name regexes, delta series summed with `sum_over_time` (never `rate`/`increase`), the window = `period`, aggregated to one series: `ci_failure_rate` = `ci.result{result="red"}` ÷ all `ci.result` per day (days without CI skipped); `cycle_time` = p50 of `intent.duration{kind="cycle",outcome="done"}` per day; `cost_per_intent` = p50 of `intent.cost` per day; `change_failure_rate` ([MET-25](metrics.md): `escapes{where="e2e"}` ÷ merged intents) per week, `baseline: rolling_182d`; `eval_pass_rate` = the day's last `eval.pass_rate{kind="baseline"}` (days without a run skipped), `baseline: rolling_182d`, `side: low`; the others `side: high`. The three rates `min_shift: 0.05`. 3σ routes: `cycle_time` `[pull_request]`, the others `[pull_request, runbook:pause]`. | test_default_bands |
| MNT-3 | **Detection is pure code, no model.** A band is due when its last completed period end `E = ⌊(now − 600 s) / period⌋ · period` (unix s: UTC days, weeks from the epoch) is past the one it was last evaluated for (`Watch`, in memory: a new loop evaluates once more). Every 300 s (`ROUND`; not with `run --intent`) the due bands' range queries (`prom::query_range`: `GET <prometheus>/api/v1/query_range` `query`, `start = E − (N − 1) · period`, `end = E`, `step = period`, N = baseline ÷ period; 10 s timeout) run on a helper thread whose answers a later pass takes (`try_recv`): Prometheus never blocks a pass and never opens a fault; a failed band stays due, logged once per error. Answer: a `matrix` of 0 series (no points) or 1 (its `values`, non-finite skipped); more → `<band>: <n> series`. `detect(&[(t, v)], Side) -> Option<Verdict>`: the newest 8 points are judged against mean and σ (sample, n − 1) of the points before them, only when the newest is `E`'s (`fresh`: a period without a value judges nothing; its newest point was judged when new); fewer than 14 such points, or σ ≤ 10⁻⁹ · max(1, \|mean\|) (= 0) → no verdict. On the band's side, a point is beyond kσ when v − mean is strictly more than k · σ and at least `min_shift` (`detect::beyond`): the newest beyond 3σ → `3sigma`; 2 of the last 3 beyond 2σ → `2sigma`; 4 of the last 5 beyond 1σ, or the last 8 all beyond 0σ (one side of the mean) → `1sigma`; the highest tier only. A verdict → one breach event per (band, tier, newest point), in one transaction with the tier's action (`record`) and the band's **episode** (`episodes`: opened by a breach when none is open; closed, `close_episode`, by a fresh evaluation with no verdict whose newest point isn't beyond 1σ; never by `resume`/`trust`): a `breaches` row (`INSERT OR IGNORE`: band, tier, point, value, mean, sigma, at), `towercab.breaches` (labels band, tier; its event, [MET-18](metrics.md)) and the log line `band <band> at <tier>: value <v> · mean <m> · σ <s>`. | test_western_electric_rules, test_short_baseline_no_verdict, test_min_shift, test_breach_once_per_point, test_prometheus_never_blocks_a_pass, test_episode_acts_once |
| MNT-4 | **`action: log`** (`1sigma`'s): the breach event only (step `done`). | test_tier_log |
| MNT-5 | **`action: diagnose`** (`2sigma`'s): the band's draft (`drafts` key `alert:<band>`, [INT-8](intents.md)): pending or open → the breach at `comment`; else, once per episode (`episodes.drafted`: a draft I rejected isn't drafted again until the band is back within 1σ), none or finished → a new row (step `draft`; a finished one replaced, its breaches still at `diagnose`/`comment` → `done`) and `runs/draft-<rowid>/breach.json` (the band, the verdict, the series, and the transitions and the merges (PRs) of the last 8 periods) in the breach's transaction, the breach at `diagnose`; else the breach → `done`. The diagnosis is the drafter's child ([INT-7](intents.md): one at a time, a slot, after the pick; 3 tries; limits and faults as there), kind `diagnose`: model `review_model([agent].model)` ([PIP-4](pipeline.md)), `--tools ""` ([PIP-24](pipeline.md)), prompt = breach.json's facts and the last 5 `lessons/*.md` of `intents` (by name), fenced in `<data>` as data, not instructions; `--json-schema` `DIAGNOSIS_SCHEMA` `{title, problem, evidence, outcome: [string], affected, open_questions: [string], u, i, why_u, why_i, cause}` (`cause`: one of the PR URLs given, or empty). Towercab writes `intent.md` (`repo` = the band's, `u`, `i`, `source: alert:<band>`, `started` = the breach's `at`; Problem, Evidence, Proposed outcome, Affected users and systems, Open questions; must parse) and opens it by INT-8 (`repeat`), PR body `Drafted by Towercab from band <band> at <tier>: value <v> · mean <m> · σ <s>.`, the u/i bullets, `Merge to accept, close to reject.`; with the draft open the breach → `done`. A `comment` breach, once the band's draft is open: `gh pr comment <n> -R <intents github> --body "Breach: <band> at <tier> · value <v> · mean <m> · σ <s> · <point, YYYY-MM-DD HH:MM UTC>"` (skipped when a comment of Towercab's or mine starts with that line) → `done`; the draft finished first → `done`. Both in the drafts poll (`settle`, every 300 s). | test_diagnosis_drafts_intent, test_one_draft_per_band, test_episode_acts_once |
| MNT-6 | **`action: propose`** (`3sigma`'s): `pull_request` in `routes` = as `diagnose`; then, once per episode (`episodes.proposed`: a later breach in it never re-applies what I reversed), each `runbook:<name>` and the message, in code, in the breach's transaction: `cap_repo` (the band's repo, `[repos]` only: `repo_caps.capped = 1`, why `<band> at 3σ`, as [AUT-10](autonomy.md); cleared by `trust`) or `pause` (`meta.paused = 1`, as `pause`: no picks until `resume`); the message `triage: <band> at 3σ` ([LOOP-14](loop.md); outbox `loop`, `triage:<band>`, the point's unix s; `PR <url>` when the band's draft is already open). | test_runbook_cap_repo, test_runbook_pause, test_episode_acts_once |
| MNT-7 | **Triage** is the intent PR: merge = fix accepted (it runs like any intent), close = dismissed. `drafts::poll_drafts` moving an `alert:<band>` draft to `accepted`/`rejected` adds 1 to the band's `triage.accepted`/`dismissed` in the same transaction; `status` shows `alerts dismissed: <band> <n>, …` (bands with one, [LOOP-13](loop.md)); I tune `bands.yaml` myself. | test_dismissal_counted |
| MNT-8 | **Lessons:** an intent with `source: alert:<band>` and `stage: done` gets a `lessons` row (step `wait`; `fixed` = its last mission's `finished`, `pr` = its `pr`) in the drafts poll; the band's first evaluation with a point whose period began at or after `fixed` records it (`value`, `within` = \|v − mean\| ≤ σ, unknown without a baseline) → `write`; so does the band leaving `bands.yaml` or 8 periods without one (no value). The next drafts poll writes `lessons/<yymmdd of fixed>-<slug>.md` on `main` of `intents` (`Store::put`, commit `towercab: lesson <id>`, **Lesson**) → `written`. Eval cases ([PIP-33](pipeline.md), `evals::write_case`) are `incident: true` when the intent's source is `alert:*`, a mission of it had `red` out of `e2e` (then reverted, [PIP-19](pipeline.md), or left at `e2e red after your merge`, [PIP-20](pipeline.md)), or its case already was; the drafts poll writes the case of each mission with a `red` out of `e2e` whose case isn't incident yet; `evals::cases` always replays incident cases. | test_lesson_written, test_incident_eval_always_replayed |

**Bands** (`ops/bands.yaml`; names `[a-z0-9_]+`, unique)

```yaml
bands:
  <name>:
    metric: ci.result
    query: <PromQL>
    period: 1d
    baseline: rolling_30d
    rules: western_electric
    side: high
    min_shift: 0.05
    repo: towercab
    tiers:
      1sigma: {action: log}
      2sigma: {action: diagnose}
      3sigma: {action: propose, routes: [pull_request, runbook:pause]}
```

**Default bands** (`C(n)` = `{__name__=~"towercab_<n>(_total)?"…}`, `B(n)` = `…(_seconds|_USD)?_bucket`, `N(n)` = `…(_seconds)?_count`, `G(n)` = `…(_ratio)?`; selectors inside the braces)

| Band | period · baseline · side | Query |
|---|---|---|
| `ci_failure_rate` | 1d · 30d · high | `(sum(sum_over_time(C(ci_result){result="red"}[1d])) or vector(0)) / sum(sum_over_time(C(ci_result)[1d]))` |
| `cycle_time` | 1d · 30d · high | `histogram_quantile(0.5, sum by (le) (sum_over_time(B(intent_duration){kind="cycle",outcome="done"}[1d])))` |
| `cost_per_intent` | 1d · 30d · high | `histogram_quantile(0.5, sum by (le) (sum_over_time(B(intent_cost)[1d])))` |
| `change_failure_rate` | 1w · 182d · high | `(sum(sum_over_time(C(escapes){where="e2e"}[1w])) or vector(0)) / sum(sum_over_time(N(intent_duration){kind="lead",outcome=~"done\|reverted\|revert_failed"}[1w]))` |
| `eval_pass_rate` | 1d · 182d · low | `max(last_over_time(G(eval_pass_rate){kind="baseline"}[1d]))` |

**Lesson** (`lessons/<yymmdd>-<slug>.md`; lines `one_line`; times `YYYY-MM-DD HH:MM UTC`)

```
# Lesson: <intent title>

- Intent: <id> (source: alert:<band>)
- Anomaly: <band> at <tier> on <point>: value <v> · mean <m> · σ <s>     (its breach: the latest at or before `started`; none → "<band>: no breach recorded")
- Cause: <the intent's ## Problem, first paragraph, ≤ 300 chars>
- Fix: <pr url|none>
- After the fix: <v> on <point>, back within 1σ: yes|no|unknown       (or "After the fix: no value")
- Eval case: evals/<id>.json (incident)
```

**Code** (all `pub`; tests in `tests/maintain*.rs`)

| File | Interface |
|---|---|
| `src/maintain/bands.rs` | `Band { name, metric, query, period: u64 (s), baseline: u64 (s), side: Side, min_shift: f64, repo: Option<String>, tiers: [Action; 3] }` (`points()` = baseline ÷ period, `end(now)` = E), `Side::{High, Low, Both}`, `Tier::{One, Two, Three}` (`as_str`: `1sigma`…), `Action::{Log, Diagnose, Propose { pull_request, cap_repo, pause }}`; `parse(&str) -> Result<Vec<Band>, String>`; `PATH` (`ops/bands.yaml`), `read(&Config, &Exes) -> Result<Option<Vec<Band>>, String>` (`None`: no Towercab repo or clone; no file → `Some([])`). |
| `src/maintain/detect.rs` | `Verdict { tier, point: (t, v), mean, sigma }`, `stats(&[f64]) -> Option<(mean, sigma)>`, `baseline(&[(f64, f64)]) -> Option<(mean, sigma)>`, `beyond(shift, sigma, k, min_shift, Side) -> bool`, `detect(&[(f64, f64)], Side, min_shift) -> Option<Verdict>`, `RECENT` (8), `MIN_BASELINE` (14), `FLAT` (10⁻⁹). |
| `src/maintain/prom.rs` | `query_range(base, query, start, end, step, timeout) -> Result<Vec<(f64, f64)>, String>`, `parse_matrix(&Value) -> Result<…>`, `TIMEOUT` (10 s); `Query { band, query, start, end, step }`; `Fetch` (a thread: `start(base, Vec<Query>, timeout)`, `poll() -> Option<Result<Vec<(band, Result<points, String>)>, String>>`, never waits). |
| `src/maintain/mod.rs` | `Watch` (`round(&mut self, &Config, &Exes, &Db, &Home, Tick)`: answers taken, due bands fetched, failures logged, never the pass's; `checked(band)`, `fetching()`; `ROUND` (300 s), `GRACE` (600 s), `CONTEXT` (8)); `fresh(points, E) -> bool`; `evaluate(…, &Band, points, E, Tick)` = `detect` (when `fresh`) → `record` or `close_episode`, then `evaluated`; `episode(&Connection, band) -> Option<(drafted, proposed)>`, `close_episode(&Connection, band)`; `record(&Db, &Config, &Home, &Band, &Verdict, &[(f64, f64)], Tick) -> Result<bool, String>` (MNT-3..6; `breach_json`); `evaluated(&Connection, &Band, &[(f64, f64)], Option<(mean, sigma)>)` (lessons' value); `settle(&mut Ctx) -> Result<(), GhError>` (MNT-5's comments and `done`s, MNT-8's rows, lessons and the cases of open intents with an e2e red); `opened(&Ctx, band)`; `triaged(&Connection, band, result)`, `dismissed(&Connection)`; `incident(&Connection, &Intent) -> bool`, `incident_since(&Connection, &Intent) -> Option<f64>`. |
| `src/maintain/diagnose.rs` | `DIAGNOSIS_SCHEMA`, `Diagnosis::from_json`, `prompt(&Value breach, lessons: &[(name, text)]) -> String`, `intent_md(&Diagnosis, repo, band, started)`, `pr_body`, `merges(&Value) -> Vec<url>`, `lessons(&Store) -> Vec<(name, text)>` (newest 5), `CAUSE` (`runs/draft-<rowid>/cause`), `utc(t)`. |
| `src/maintain/lessons.rs` | `text(…) -> String` (**Lesson**), `path(fixed, slug, offset)`. |
| callers | `Loop::pass` (`Watch::round` after the due polls), `Loop::poll_drafts` (`settle` after `drafts::poll_drafts`), `drafts::{next_run, finish_run}` (`runner`: an `alert:` row is diagnosed; `opened` after its draft opens), `drafts::poll_drafts` (`triaged`), `drafts::comment_pr_once`, `evals::{read_case, write_case}` (`incident`, MET-27), `status` (`dismissed`). |

## Out of scope

- Live services' own metrics and scheduled e2e ([PIP-10](pipeline.md)): offered, not chosen.
- Slack and Claude Tag: Telegram is the channel ([LOOP-14](loop.md)).
- Changing bands automatically from dismissals.

## Decisions

- Towercab's own process only (my call): its metrics are already in Prometheus; services come later.
- Playbook tiers (my call): detection deterministic; Claude only diagnoses; the only actions at 3σ are
  pre-approved, reversible runbooks.
- A breach becomes an intent PR, never a runnable intent: nothing a machine writes runs without my merge.
- `yaml-rust2` parses `bands.yaml`: already the front matter's parser, so no new crate; a hand parser
  would re-implement flow maps and lists.
- Periods end at multiples of the period since the epoch, 10 min after (Prometheus takes samples up to
  10 min old; spooled points are stamped at the send): every loop sees the same points.
- Queries on a helper thread polled like a child: a hung Prometheus never stalls a pass. Like OTLP it
  opens no fault: watching Towercab never stops Towercab.
- `side` (added to the playbook's shape): two-sided rules alarm on improvements (faster cycles, higher
  pass rates); the defaults watch the bad side only.
- σ = 0 → no verdict: after a flat baseline (no CI failure in 22 days) the first failure would be
  "beyond 3σ" and pause the loop. σ within 10⁻⁹ of the mean's scale is 0 (a flat 0.9 sums to a
  σ of 10⁻¹⁵). `min_shift`: a nearly flat sparse rate (σ 0.002) would still call a 0.02 move
  3σ; rates breach only on a move I'd act on.
- The highest tier only: a lower tier on the same point adds nothing. Last evaluation in memory: a
  restart re-queries once and the breach key dedupes.
- The diagnosis is the drafter's child: the one Claude child outside missions (one at a time, tries,
  limits, faults). `breach.json` is written with the row, so a retry diagnoses the same facts.
- Runbooks and the triage message share the breach's transaction: paused before the next pick, never
  twice, never lost.
- Episodes: a sustained shift breaches every period for 8+ periods (the breach stays in the recent 8,
  outside the baseline). Per point, it would pause again after my `resume` and draft again after I
  closed the draft. A draft and the 3σ actions happen once per episode; the rest are events and
  comments. Closed by data only (back within 1σ), so my reversal holds. The message goes at the breach, not after the diagnosis: the runbook already acted.
- Lessons are written by code, not the writer (PIP-11): every fact is code's, the next diagnoses read
  them verbatim, and a Haiku run would be another child outside missions. A lesson waits for the band's
  first full period after the fix.
- An e2e incident's case is written when the red is seen, not when the intent is done: incident → eval
  then measures Towercab, not my approval.
- `cause` must be one of the PRs given: an alert escape counts only for a real merged PR.
