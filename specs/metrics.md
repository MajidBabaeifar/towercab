# Metrics

**Status:** Draft (Rust rewrite) · **Prefix:** MET

## Purpose

Know how intents and agent runs go, measured with the playbook's leading and lagging indicators for each play that defines them,
plus time per stage, cost, tokens and limits. In Grafana, from OTLP.

## Requirements

| ID | Requirement | Verified by |
|---|---|---|
| MET-1 | Removed: SQLite `runs` table; runs are OTLP metrics and events (MET-13..18). | — |
| MET-2 | Removed: run identity columns; labels and event attributes instead (MET-14..18). | — |
| MET-3 | Removed: run time columns; MET-14, 15, 17. | — |
| MET-4 | Removed: run usage columns; MET-16, 17. | — |
| MET-5 | Removed: run outcome columns; MET-14, 15, 17. | — |
| MET-6 | Removed: change size columns; Claude Code's `claude_code.lines_of_code.count` (MET-12). | — |
| MET-7 | Removed: after-merge columns; MET-15 (`merged_by`), MET-17 (reverts). | — |
| MET-8 | Removed: `towercab report`; the Grafana dashboard (MET-19). | — |
| MET-9 | Removed: trust suggestions in the report; change failure rate and auto-merged share on the dashboard. | — |
| MET-10 | The intent's `DONE.md` line ([INT-6](intents.md)) shows totals over all its missions, written by the `done` entry ([LOOP-6](loop.md)): cost `$<Σ cost_usd, 2 decimals>`, agent time (`Σ agent_secs`, `views::agent_time`), attempts (highest `attempt`). | test_done_line |
| MET-11 | Removed: monthly report page; the dashboard's time picker. | — |
| MET-12 | Claude Code's own telemetry. Each Claude run Towercab starts gets `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER=otlp`, `OTEL_LOGS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`, `OTEL_EXPORTER_OTLP_ENDPOINT=<[metrics].endpoint>` (default `http://localhost:4318`), `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta`, `OTEL_METRIC_EXPORT_INTERVAL=30000`, `OTEL_SERVICE_NAME=towercab` (the dashboard's Source filter). For my own sessions `towercab telemetry on\|off\|status` (`src/telemetry.rs`, replaces `ops/telemetry`) edits `env` of `$CLAUDE_CONFIG_DIR/settings.json` (unset or empty → `~/.claude/settings.json`; created with its directory): `on` sets the same vars minus `OTEL_SERVICE_NAME` (endpoint from the config; no loadable config → the default), other keys kept; `off` removes only those vars still holding those values (an `env` left empty is removed); written whole via `settings.json.tmp` + rename, 2-space JSON + newline. Prints `telemetry on\|off (<path>); applies to new Claude Code sessions`; `status` prints `telemetry on\|off (<path>)` (on = every var present with its value). A settings file that isn't a JSON object → exit 1, untouched; another argument → exit 2. | test_claude_env, test_on_off_keeps_other_settings, test_off_keeps_values_it_did_not_set, test_telemetry_creates_file_and_rejects_bad_args |
| MET-13 | **Emitter** (`src/metrics.rs`, **Code**): a call takes a `Metric` of the one list `METRICS` (**Names**) and appends a record to a per-thread buffer: no I/O, can't fail (≤ 10 000 records, the oldest dropped; a record made inside a `Db::tx` that rolls back is dropped). `Sink::flush` (end of every pass, `shutdown`, `step_intent`, and the CLI's `approve` … `trust`, `eval`) sends it as OTLP/HTTP JSON (**OTLP**) to `<[metrics].endpoint>/v1/metrics` and `/v1/logs`, 2 s timeout each, resource `service.name=towercab-loop`, delta temporality. A failed send (no answer or non-2xx) → the records appended to `<home>/metrics.jsonl` (**Spool**), and for 60 s every flush goes straight to the spool; the next successful send first replays the spool, oldest first: metric points stamped with the send time (Prometheus rejects samples older than 10 min), events with their own. Never blocks a pass beyond one 2 s attempt a minute, never fails it, never opens a fault. A test checks every dashboard query's `towercab_*` names against `METRICS`. | test_metric_otlp, test_metric_spool, test_spool_bounded, test_dashboard_names |
| MET-14 | `towercab.stage.duration` (histogram, s), labels `repo`, `stage` (a driven [LOOP-3](loop.md) stage), `result`: one sample per `machine::apply` of a mission at a driven stage whose event ends a segment there: `ok`, `red`, `blocked` (→ a wait), `timeout` (`timeout`, `bad_result`), `limit`, `crash` (also `Unexpected`), `interrupted` (also any other event that moves it out: `feedback`, `conflict`, `head_moved`, `pr_merged`, `pr_closed`, `intent_removed`, `retry_fresh`); none for `env_fail`, `pause`, `resume`. Value = now − the segment's start: the later of its last transition into the stage from another and its last segment-ending transition at the stage; neither → `missions.created`. | test_stage_metric |
| MET-15 | `towercab.intent.duration` (histogram, s) once per end of an intent's mission (`machine::apply`): entering `done` (`outcome` `done`), `stopped` (`closed` by `pr_closed`; else `stopped`: `intent_removed`, `retry_fresh`; not after a `reverted`/`revert_failed` sample), or `blocked` with `reverted, refine` (`reverted`) or `revert failed` from a revert stage (`revert_failed`). Labels `repo`, `source` (kind of the intent's `source`: `me`, `issue`, `alert`, `review`; none or not listed → `me`), `outcome`, `merged_by` (`towercab`, `human`, `none`), `gate` (`data.gate.label`, **Gate labels**; no gate ran → `none`); `kind` = `lead` (created: `started`, else the id's time → now) and `cycle` (the intent's first mission's `created`, i.e. picked → now): two samples. Plus `towercab.intent.cost` (histogram, USD, this mission's `cost_usd`; labels `repo`, `outcome`). | test_intent_metric |
| MET-16 | Per Claude run, from its `-p` JSON result however the run ended (a limit or failure cost too; no result → nothing): one sample per `modelUsage` key (`model` = key): `towercab.cost.usd` (counter, USD, API-price estimate, from `costUSD`) and `towercab.tokens` (counter, `type` = `input`, `output`, `cache_read`, `cache_creation`, from `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`), labels `repo`, `agent` (`Run::agent`: `worker` = design, plan, build, repairs; `review`, `verifier`, `triage`, `writer`, `drafter`, `diagnose`, `eval`), `model`, `stage` (the mission's; the drafter's `draft`). In `runs::finish` (mission runs, writer included) and `drafts::finish_run`. `total_cost_usd` is summed onto the mission for the DONE line (MET-10). | test_run_usage_per_model |
| MET-17 | Counters, labels `repo` unless named: `towercab.ci.repairs` (+1 per `red` out of `ci`); `towercab.ci.result` per CI result at `ci` (`ok` → `data.ci.result`: `green`, `flaky`, `none`; `red` or the `CI red` wait → `red`; `CI stuck`, `no CI checks appeared` → `timeout`), `first` = `yes` when the mission had no CI result before (its first head after the build; design runs no CI stage), else `no`; `towercab.reverts` (`merged_by` of the reverted merge, `result` = `ok` entering `reverted, refine`, `failed` entering `revert failed` from a revert stage); `towercab.usage_limit.waits` (+1 when `limits::cool` starts a model's wait: no cooldown running) and `towercab.usage_limit.wait.duration` (counter, s: what `cool` adds to that model's wait), both labelled `model` only. | test_counters |
| MET-18 | `intent_id` is never a metric label (cardinality). Every counter and histogram record is also an OTLP log record (**OTLP**): body `<name> <value>`, attributes its labels + `metric`, `value`, and `intent_id`, `stage`, `pr` when known; time = when recorded. Gauges write none (every 60 s, no intent). | test_metric_log_event |
| MET-19 | `docker compose -f ops/docker-compose.yml up -d` runs `grafana/otel-lgtm:0.35.0` on 127.0.0.1 (3000 Grafana, 4317/4318 OTLP), data in volume `lgtm-data`, Prometheus `--enable-feature=otlp-native-delta-ingestion`, retention 400 d. It provisions one overall dashboard `ops/grafana/dashboards/towercab.json` (uid `towercab-overview`, home, no repo filter, refresh picker 10 s–1 d, default 1 m; generated by `ops/grafana/build_dashboard.py`, a test compares). Ports also 127.0.0.1:9090 (Prometheus, for bands, [MNT-1](maintain.md)). Sections: **Loop** (state, backlog, active runs); one per playbook stage, **Plan**, **Design**, **Build**, **Test**, **Deploy**, **Maintain**, each showing its plays' leading and lagging indicators (MET-22); **Intents** (done, lead/cycle p50/p90, cost and tokens per intent, auto-merged share, time per stage, gate outcomes, cost by agent, paused on limit, event log `service_name="towercab-loop"`). **Claude Code usage:** cost, tokens, sessions, active time, cache hit rate, lines, cost by model and main vs subagent, tokens by type, commits, PRs. Delta series are summed (`sum_over_time`), never `rate`/`increase`/`irate`. | test_refresh_picker_and_overall_only, test_panels_well_formed, test_dashboard_names, test_dashboard_is_generated, test_delta_counters_summed_not_increased, manual (open Grafana) |
| MET-20 | Gauges every 60 s (the pass's gauges step, [LOOP-12](loop.md)), every value sent (0 too): `towercab.backlog` by `state`: `runnable` / `parked` (`priority::pick_order` at or above / below the cutoff), `in_flight` (unfinished intent and revert missions not at `approval:*` or `blocked`), `waiting_on_me` (missions at `approval:*` or `blocked`, and open intents with `waiting` and no unfinished mission), `blocked` (queued intents with an `after:` id not done); `towercab.loop.state` = 1 for the current `state`, 0 for the others: `paused` (`meta.paused`) > `env_blocked` > `running` (a child runs, or a driven mission not in a limit wait) > `limit` (every driven mission in a limit wait) > `idle`. | test_gauges |
| MET-21 | Buckets: duration histograms (s) 5, 15, 30, 60, 300, 900, 1800, 3600, 7200, 14400, 28800, 86400, 172800, 604800, 1209600, 2592000, 7776000; `towercab.rework.cycles` 0, 1, 2, 3, 4, 6, 9, 12; `towercab.intent.cost` 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25, 50 USD. | test_buckets |
| MET-22 | Each play with a playbook "How to measure it" (12 of 15; Auto mode, Hooks as build-time guardrails and Claude Tag have none) has its leading and lagging indicator, computed as in **Indicators** below from MET-14..17, 20 and 23..27; a team-only one reads `n/a: <playbook indicator>`. The dashboard shows them by stage. | test_dashboard_names, manual (open Grafana) |
| MET-23 | **Plan, Design** (from git timestamps, as in the playbook): `towercab.intent.drafts` (counter; `source` = the draft's kind `issue`/`alert`/`review`, `result` = `accepted`/`rejected`: `drafts::poll_drafts` moving its row there); `towercab.intent.time_to_intent` (histogram; `source`; at `design`'s entry from `pick` on attempt 1: `started` ([INT-2](intents.md)) → committer time of the oldest first-parent commit on `main` of `intents` that added `intents/<dir>/intent.md`; no `started` → not measured); `towercab.spec.lead.duration` (histogram; at the entry after the design's first exit, when `data.design.spec_ids` isn't empty: that commit time → now); `towercab.intent.edits_after_spec` (counter, at the merge's `deploy` entry: first-parent commits of `main` touching the intent's `intent.md` after the design's first exit whose subject doesn't start `towercab: ` (Towercab's own) and whose old → new `intent.md` differs in the body without `## Towercab`, or in `u`/`i`/`a`/`repo`/`unlock`); `towercab.spec.rework` (counter, at the merge's `deploy` entry: commits in the mission checkout's `merge-base(head, origin/<base>)..head` committed after the first exit from `plan` that change `specs/**`, build and repair commits included). | test_plan_design_metrics |
| MET-24 | **Build**, at the merge (the transition into `deploy` by `ok` from `merge` or by `pr_merged`): `towercab.first_pass` (counter; `result` = `yes` when the mission had no `red` out of verify, proof or ci, no `feedback` and no `conflict`), `towercab.plan_to_merge.duration` (histogram; first exit from `plan` → merge), `towercab.rework.cycles` (histogram; the mission's transitions into `build` by `red`, `feedback` or `conflict`), `towercab.plan.result` (counter; `drifted` when `data.review.result.plan_followed.followed` is false, else `updated` when a build rewrote `plan.md` (`data.plan_updated`), else `followed`); at the merge's `deploy` entry `towercab.claude_md.updates` (counter; 1 when `merge-base..head` changes `CLAUDE.md`, else 0). `towercab.findings.repeated` (counter; `findings::record`: each row added whose (repo, rule) another PR already has). Gauge `towercab.active` (every 60 s: the loop's children, the missions', the drafter and an eval child). | test_build_metrics |
| MET-25 | **Test:** `towercab.eval.pass_rate` (gauge 0–1 per eval run, `kind` = `baseline`/`pr`: `towercab eval` (`--reason`, `--pr`) at its end); `towercab.eval.gate` (counter, labels none: the gate's first decision on a head of a Towercab PR whose `towercab/evals` it read; `result` = `pass` (success) / `drop` (failure, error)); `towercab.escapes` (counter, `where` = `e2e`: once per mission, its first of: `red` out of `e2e`, the waits `e2e red after your merge` and `production e2e red`). **Change failure rate** = `escapes` ÷ merged intents (`intent.duration{kind="lead"}` with `outcome` in `done`, `reverted`, `revert_failed`), per week. | test_test_metrics, test_change_failure_rate |
| MET-26 | **Deploy:** `towercab.review.findings` (counter per finding of `data.review.result` at the gate's first decision on a head (`data.gate.counted`); `pass`, `policy` (skill name or `none`), `severity`, `path` = `auto` (merge) / `approval`), `towercab.review.first.duration` (histogram; first exit from `publish` (PR ready) → first `ok` out of `review`), `towercab.feedback.rounds` (counter at the merge; one per `feedback` transition; `resolved_by` = `me` when a `head_moved` follows it before the next `feedback` or the merge, else `worker`), `towercab.gate.wait.duration` (histogram; each transition out of a wait: since the transition into it; `gate` = `spec` (approval:spec), `merge` (approval:merge), `release` (approval:release), `answer` (`answer the question`), `protected` (`protected path changed`), `other` (any other `blocked`)), `towercab.guard.blocks` (counter; `kind` = `protected`/`test_lock`: `runs::finish` of a worker run counts `guard-blocks.jsonl` lines past the number in `guard-blocks.seen`, then writes it), `towercab.gate.violations` (counter at the `deploy` entry of a Towercab merge: 1 when `merge-base..head` touches a [REPO-8](repo.md) path `Protected::new(protected, unlock)` blocks, else 0; target 0), `towercab.ci.triage` (counter; `by` = `worker` on a `red` out of `ci`, `me` on the `CI red` wait), DORA: `towercab.deploys` (counter; `deploy`'s `ok` with a deploy seen: `env` = `staging` when the repo has a ` ```release ` block, else `production`; `release`'s production deploy seen: `production`), `towercab.change.lead.duration` (histogram; the oldest commit's committer time in `merge-base(head, origin/<base>)..head` of the mission checkout → the production deploy seen: the release's if the repo has a ` ```release ` block, else `deploy`'s), `towercab.restore.duration` (histogram; the transition `e2e` → `rollback` → entering `reverted, refine`). | test_deploy_metrics |
| MET-27 | **Maintain** (with [MNT-3, 5, 8](maintain.md)): `towercab.breaches` (counter; `band`, `tier`), `towercab.breach_to_intent.duration` (histogram; breach → draft intent PR), `towercab.incident_to_eval.duration` (histogram; breach ([MNT-3](maintain.md)) or first e2e red ([PIP-9](pipeline.md)) → its `incident: true` eval case on `main` of `intents`), `towercab.escapes{where="alert"}` (a breach traced to a merged change); dismissals via `towercab.intent.drafts{source="alert",result="rejected"}`. | test_maintain_metrics |

## Indicators

The playbook's "How to measure it", per play.

| Stage | Play | Leading | Lagging |
|---|---|---|---|
| Plan | Capture intent | Time to intent (`intent.time_to_intent`, by source) | Survival rate (`intent.drafts` accepted ÷ all); intent edits after the spec (`intent.edits_after_spec`) |
| Design | Requirements and design | Intent → spec (`spec.lead.duration`) | Spec rework after the plan (`spec.rework`) |
| Build | Plan mode | First-pass merge share (`first_pass`); plan → merge (`plan_to_merge.duration`) | Rework cycles (`rework.cycles`); plan drift (`plan.result`) |
| Build | CLAUDE.md | Repeated mistakes (`findings.repeated`); `CLAUDE.md` corrections merged (`claude_md.updates`) | n/a: time to first merged PR for a new joiner |
| Build | Skills | n/a: policy-owner approval → skill merged (I own every policy) | Findings citing each policy skill (`review.findings{policy}`) falling to zero |
| Build | Parallel sessions | Active runs (`active`) while Important findings per PR (`review.findings{severity="important"}`) hold | Intents done per week (`intent.duration{outcome="done"}`) with rework (`rework.cycles`) |
| Test | Feedback loop | First-pass CI rate (`ci.result{first="yes"}`) | Wait for my merge (`gate.wait.duration{gate="merge"}`); change failure rate (MET-25) |
| Test | Evals | Eval pass rate (`eval.pass_rate`); incident → eval (`incident_to_eval.duration`) | Regressions caught by the eval gate (`eval.gate{result="drop"}`) vs escaped (`escapes`) |
| Deploy | PR review | Time to first review (`review.first.duration`); feedback resolved by the worker (`feedback.rounds`) | Important findings before merge vs `escapes` |
| Deploy | Approval gates | Wait per gate (`gate.wait.duration{gate}`) | Gate violations (`gate.violations`, target 0) |
| Deploy | CI/CD | CI failures handled without me (`ci.triage{by="worker"}`) | DORA: deploy frequency (`deploys`), lead time for changes (`change.lead.duration`), change failure rate (MET-25), time to restore (`restore.duration`) |
| Maintain | Closing the loop | Breach → intent (`breach_to_intent.duration`) | Alert findings merged as fixes (`intent.duration{source="alert",outcome="done"}` ÷ `intent.drafts{source="alert"}`); repeat breaches per band (`breaches`) |

Names are `towercab.<name>`. Auto mode, Hooks as build-time guardrails and Claude Tag have no playbook indicator.

**Names** (`metrics::METRICS`: `Metric::ALL`, `name()`, `instrument()`, `unit()`; Prometheus: `.` → `_`, unit `s` → `_seconds`, `USD` → `_USD`, `1` → `_ratio`, counters `_total`, histograms `_bucket`/`_sum`/`_count`)

| Instrument | Unit | Names |
|---|---|---|
| counter | — | `ci.repairs`, `ci.result`, `reverts`, `usage_limit.waits`, `tokens`, `intent.drafts`, `intent.edits_after_spec`, `spec.rework`, `first_pass`, `plan.result`, `findings.repeated`, `claude_md.updates`, `eval.gate`, `escapes`, `review.findings`, `feedback.rounds`, `guard.blocks`, `gate.violations`, `ci.triage`, `deploys`, `breaches` |
| counter | USD; s | `cost.usd`; `usage_limit.wait.duration` |
| histogram | s (duration buckets) | `stage.duration`, `intent.duration`, `intent.time_to_intent`, `spec.lead.duration`, `plan_to_merge.duration`, `incident_to_eval.duration`, `review.first.duration`, `gate.wait.duration`, `change.lead.duration`, `restore.duration`, `breach_to_intent.duration` |
| histogram | USD; — | `intent.cost` (cost buckets); `rework.cycles` (rework buckets) |
| gauge | —; 1 | `backlog`, `loop.state`, `active`; `eval.pass_rate` |

**Gate labels** (`data.gate.label`, written by the gate with its decision): merge → `a<n>` (effective `a`) or `risk_low`; hold → `frozen`, `ci_red` (CI not green), `no_ci`, `unlock`, `evals_red` (also not posted after 12 h), `capped`, `a<n>`, `not_approved`, `risk_high`.

**OTLP** (one POST each per flush; records aggregated per (metric, labels): counters summed, histograms merged, gauges the last value)

```
/v1/metrics {resourceMetrics: [{resource: {attributes: [{key: "service.name", value: {stringValue: "towercab-loop"}}]},
  scopeMetrics: [{scope: {name: "towercab", version: <crate version>}, metrics: [
    {name, unit, sum: {aggregationTemporality: 1, isMonotonic: true, dataPoints: [P + asDouble]}}       counter
    {name, unit, histogram: {aggregationTemporality: 1, dataPoints: [P + count, sum, bucketCounts, explicitBounds]}}
    {name, unit, gauge: {dataPoints: [P + asDouble]}}]}]}]}
  P = {attributes: [{key, value: {stringValue}}], startTimeUnixNano, timeUnixNano}: time = the send; start = the earliest
      record's time, at most 10 min before it (gauges: = time); 64-bit integers as strings
/v1/logs {resourceLogs: [{resource: <same>, scopeLogs: [{scope: <same>, logRecords: [{timeUnixNano: <recorded>,
  observedTimeUnixNano: <send>, severityNumber: 9, severityText: "INFO", body: {stringValue: "<name> <value>"},
  attributes: [<labels>, metric, value, intent_id?, stage?, pr?]}]}]}]}
```

**Spool** (`<home>/metrics.jsonl`): one record per line `{"metric", "value", "labels": {…}, "at": <unix s>, "intent_id"?, "stage"?, "pr"?}`; gauges are never spooled (the next 60 s has fresh ones); ≤ 4 MiB: an append that would pass it first drops the oldest lines down to 2 MiB; appends and rewrites under `flock` (the loop and its `eval` child share a home); replayed oldest first, at most 5 000 lines a send; a replayed batch is removed from the file; a line that doesn't parse is dropped.

**Code** (all `pub`; tests in `tests/metrics*.rs`, `tests/dashboard.rs`, `tests/telemetry.rs`)

| File | Interface |
|---|---|
| `src/metrics.rs` | `Metric` (`ALL`, `name`, `instrument`, `unit`), `Instrument::{Counter, Histogram(&[f64]), Gauge}`, `METRICS`, `DURATION`, `REWORK`, `COST`; `Ev { intent, stage, pr }` (`Ev::of(&Mission)`, `Ev::none()`); `add(Metric, f64, &[(&str, &str)], &Ev)`, `observe(…)`, `gauge(Metric, f64, &[(&str, &str)])`; `Record { metric, value, labels, ev, at, seq }`; `take() -> Vec<Record>`, `mark() -> u64`, `drop_since(u64)` (`Db::tx`), `eval_scope() -> EvalScope` (while it lives only `cost.usd`/`tokens` are kept: PIP-33's replay); `Sink { endpoint, spool, down_until }` (`Sink::new(&Config, &Home)`, `flush(&mut self, now: Tick)`), `payload(&[Record], now) -> (Value, Value)`, `spool_append(path, &[Record])`, `spool_read(path, max) -> Vec<Record>`, `TIMEOUT` (2 s), `RETRY` (60 s), `SPOOL_MAX` (4 MiB), `BUFFER` (10 000). |
| `src/indicators.rs` | Where each metric comes from: `transition(tx, &Apply, cur: &Mission, &Outcome, to: Stage, stored: &Mission)` (from `machine::apply_tx`: MET-14, 15, 17, 24's merge set, 25's escapes, 26's review.first, feedback.rounds, gate.wait, ci.triage, restore), `entered(cx, &Mission)` (from `machine::enter` after its intent write, git in the intents checkout and the mission checkout: MET-23's time_to_intent, spec.lead, edits_after_spec, spec.rework; MET-24 claude_md.updates; MET-26 gate.violations), `run_usage(repo, agent, stage, &ClaudeResult, &Ev)`, `guard_blocks(cx, &Mission)`, `gate_label(&Gate, a)`, `gauges(&Db, Option<&Listing>, cutoff, children, now)`; `source_kind(&str)`. |
| `src/telemetry.rs` | `vars(endpoint) -> [(&str, String); 7]`, `settings_path() -> Result<PathBuf, String>`, `run(what, endpoint) -> Result<String, String>`. |
| callers | `limits::cool` (usage_limit), `drafts::{finish_run, poll_drafts}`, `findings::record`, `gate::decide` (review.findings, eval.gate, `gate.label`), `build` (`data.plan_updated`), `deploy`/`release` (deploys, change.lead), `evals::{baseline, pr}` (pass_rate), `Loop::gauges`; `Loop.metrics: Sink`, flushed at the end of `pass`, `shutdown`, `step_intent`. |

## Out of scope

- Alerting beyond bands ([maintain.md](maintain.md)); messages only when I must act ([LOOP-14](loop.md)).

## Decisions

- Lead time = created → done; cycle time = picked → done.
- `cost_usd` on a subscription is an API-price estimate, not a bill; the real cost is usage-limit burn.
- Cost and tokens come from each `claude -p` result: exact per run, no transcript parsing or price table.
- Delta temporality end to end: Claude Code's default, and the only kind short processes emit
  correctly. Prometheus stores deltas as-is; queries use `sum_over_time`, never `rate`/`increase`
  (which drop each new series' first sample, i.e. most of a short `claude -p` run). Names matched
  by regex (`claude_code_cost_usage(_USD)?(_total)?`) so OTel→Prometheus suffix rules can't break panels.
- `intent_id` never a metric label (cardinality); it lives in events (MET-18).
- The playbook's indicators as the standard (my call); team-only ones dropped.
- OTEL variables for my own sessions live in user settings, not a repo's `.claude/settings.json`:
  Claude Code ignores them there.
- Names follow `towercab.*`; Claude's own stay `claude_code.*`. Claude runs are `service.name=towercab`,
  the loop's own data `towercab-loop`, so Claude's log events don't flood the intent event log.
- No `OTEL_RESOURCE_ATTRIBUTES` on Claude runs: Prometheus wouldn't promote them; per-agent and
  per-stage cost comes from MET-16 instead.
- Metric calls write to a per-thread buffer (like a logger), flushed once per pass: no handler,
  transition or transaction ever waits on the network, and a crash loses at most one pass of
  records instead of counting twice. A transaction that rolls back drops its records.
- Most indicators are derived where the state machine already records the facts: `machine::apply`
  (transitions, `missions.data`) and `machine::enter` (git, once per entry: after its intent write,
  whose mark makes a re-run skip it). Handlers emit only what only they see (findings, gate, deploys).
- Git-derived values use commit and transition times: the spec time is the design's first exit, the
  plan's the first exit from `plan`; no extra state.
- One sample per mission end, not per intent: a fresh attempt ends its mission (`stopped`); a
  `reverted`/`revert failed` mission counts there, not again when replaced. A wait isn't an end, so
  `blocked` is no outcome.
- `usage_limit.wait.duration` is a counter of seconds (what each cooldown adds): a wait's end is
  never observed, only its planned length; its sum is the dashboard's "paused on usage limit".
- Gauges are never spooled or turned into events: a stale gauge stamped with a later time would lie.
- Maintain-fed values (breaches, incident → eval, alert escapes) wait for [maintain.md](maintain.md):
  MET-27 collects them.
- `towercab telemetry` works without a Towercab config (default endpoint): it is for my own sessions.
