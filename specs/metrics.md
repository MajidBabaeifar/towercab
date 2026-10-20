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
| MET-10 | The intent's `DONE.md` line shows totals: cost, agent time, attempts ([INT-6](intents.md)). | test_done_line |
| MET-11 | Removed: monthly report page; the dashboard's time picker. | — |
| MET-12 | Claude Code's own telemetry. Each Claude run Towercab starts gets `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER=otlp`, `OTEL_LOGS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`, `OTEL_EXPORTER_OTLP_ENDPOINT=<[metrics].endpoint>` (default `http://localhost:4318`), `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta`, `OTEL_METRIC_EXPORT_INTERVAL=30000`, `OTEL_SERVICE_NAME=towercab` (the dashboard's Source filter). For my own sessions, `towercab telemetry on` writes the same vars minus the service name into `env` of `~/.claude/settings.json` (`$CLAUDE_CONFIG_DIR`), other settings kept; `off` removes only those values; `status` prints on/off. Until the Rust binary exists, `ops/telemetry on\|off\|status` does the same. | test_claude_env, test_on_off_keeps_other_settings, test_off_keeps_values_it_did_not_set |
| MET-13 | Towercab's own metrics and events: `src/metrics.rs` sends OTLP/HTTP JSON, delta temporality, resource `service.name=towercab-loop`, to `[metrics].endpoint`. Unreachable → appended to `<home>/metrics.jsonl`; on the next success, metric points are sent stamped with the send time (Prometheus rejects samples older than 10 min), events with their own time. Never blocks or fails the loop. One name list in code; a test checks every dashboard query against it. | test_metric_otlp, test_metric_spool, test_dashboard_names |
| MET-14 | `towercab.stage.duration` (histogram, s), labels `repo`, `stage` ([LOOP-3](loop.md) stages), `result` (`ok`, `red`, `blocked`, `timeout`, `limit`, `crash`, `interrupted`): on every stage exit. | test_stage_metric |
| MET-15 | `towercab.intent.duration` (histogram, s), labels `repo`, `source` (`me`, `issue`, `alert`, `review`: the kind, never the URL), `outcome` (`done`, `reverted`, `revert_failed`, `blocked`, `closed`, `stopped`), `merged_by` (`towercab`, `human`), `gate` (`a1`..`a5`, `risk_low`, `risk_high`, `capped`, `unlock`, `frozen`, `no_ci`); `kind` = `lead` (created → done) and `cycle` (picked → done). Plus `towercab.intent.cost` (histogram, USD; the mission's summed `total_cost_usd` at its end; labels `repo`, `outcome`). | test_intent_metric |
| MET-16 | Per Claude run, from its `-p` JSON result: one sample per `modelUsage` key (`model` = key): `towercab.cost.usd` (counter, USD, API-price estimate, from `costUSD`) and `towercab.tokens` (counter, `type` = `input`, `output`, `cache_read`, `cache_creation`, from `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`), labels `repo`, `agent` (`worker` = design, plan, build, repairs; `review`, `verifier`, `triage`, `writer`, `drafter`, `diagnose`, `eval`), `model`, `stage`. `total_cost_usd` is summed onto the mission for the DONE line (MET-10). | test_run_usage_per_model |
| MET-17 | Counters `towercab.ci.repairs`, `towercab.ci.result` (`result` = `green`, `red`, `flaky`, `none`, `timeout`; `first` = `yes` on the first CI result of the first head pushed after the build (not the design's spec-only head, not repair heads)), `towercab.reverts` (`merged_by`, `result` = `ok`, `failed`), `towercab.usage_limit.waits` and `towercab.usage_limit.wait.duration` (s), labels `model`. | test_counters |
| MET-18 | `intent_id` never a metric label (cardinality); every metric call also writes an OTLP log event with `intent_id`, `stage`, `pr` for drill-down in Loki. | test_metric_log_event |
| MET-19 | `docker compose -f ops/docker-compose.yml up -d` runs `grafana/otel-lgtm:0.35.0` on 127.0.0.1 (3000 Grafana, 4317/4318 OTLP), data in volume `lgtm-data`, Prometheus `--enable-feature=otlp-native-delta-ingestion`, retention 400 d. It provisions one overall dashboard `ops/grafana/dashboards/towercab.json` (uid `towercab-overview`, home, no repo filter, refresh picker 10 s–1 d, default 1 m). Ports also 127.0.0.1:9090 (Prometheus, for bands, [MNT-1](maintain.md)). Sections: **Loop** (state, backlog, active runs); one per playbook stage, **Plan**, **Design**, **Build**, **Test**, **Deploy**, **Maintain**, each showing its plays' leading and lagging indicators (MET-22); **Intents** (done, lead/cycle p50/p90, cost and tokens per intent, auto-merged share, time per stage, gate outcomes, cost by agent, paused on limit, event log `service_name="towercab-loop"`). **Claude Code usage:** cost, tokens, sessions, active time, cache hit rate, lines, cost by model and main vs subagent, tokens by type, commits, PRs. | test_refresh_picker_and_overall_only, test_panels_well_formed, test_dashboard_names, manual (open Grafana) |
| MET-20 | Gauges every 60 s: `towercab.backlog` (`state` = `runnable`, `parked`, `in_flight`, `waiting_on_me`, `blocked`), `towercab.loop.state` = 1 for the current `state` (`running`, `idle`, `paused`, `env_blocked`, `limit`), 0 for the others. | test_gauges |
| MET-21 | Buckets: duration histograms (s) 5, 15, 30, 60, 300, 900, 1800, 3600, 7200, 14400, 28800, 86400, 172800, 604800, 1209600, 2592000, 7776000; `towercab.rework.cycles` 0, 1, 2, 3, 4, 6, 9, 12; `towercab.intent.cost` 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25, 50 USD. | test_buckets |
| MET-22 | Each play with a playbook "How to measure it" (12 of 15; Auto mode, Hooks as build-time guardrails and Claude Tag have none) has its leading and lagging indicator, computed as in **Indicators** below from MET-14..17, 20 and 23..27; a team-only one reads `n/a: <playbook indicator>`. The dashboard shows them by stage. | test_dashboard_names, manual (open Grafana) |
| MET-23 | **Plan, Design** (from git timestamps, as in the playbook): `towercab.intent.drafts` (counter; `source` kind, `result` = `accepted`/`rejected`), `towercab.intent.time_to_intent` (histogram; `started` ([INT-2](intents.md)) → committer time of the commit that put `intent.md` on `main`; no `started` → not measured), `towercab.intent.edits_after_spec` (counter; my commits after the first spec commit that change `intent.md`'s body or `u`/`i`/`a`/`repo`/`unlock`; Towercab's fields and removing `waiting` don't count), `towercab.spec.lead.duration` (histogram; that `main` commit → spec commit), `towercab.spec.rework` (counter; pushed commits after `plan.md` was first written that change `specs/**`, build and repair commits included). | test_plan_design_metrics |
| MET-24 | **Build:** `towercab.first_pass` (counter at merge; `result` = `yes` when no verify, CI, feedback or conflict round ran), `towercab.plan_to_merge.duration` (histogram), `towercab.rework.cycles` (histogram, rounds per intent), `towercab.plan.result` (counter; `followed`/`updated`/`drifted`), `towercab.findings.repeated` (counter, [PIP-36](pipeline.md)), `towercab.claude_md.updates` (counter; merged PRs that change a repo's `CLAUDE.md`), gauge `towercab.active` (active children). | test_build_metrics |
| MET-25 | **Test:** `towercab.eval.pass_rate` (gauge per eval run), `towercab.eval.gate` (counter per gated Towercab PR; `result` = `pass`/`drop`), `towercab.incident_to_eval.duration` (histogram; breach ([MNT-3](maintain.md)) or first e2e red ([PIP-9](pipeline.md)) → its `incident: true` eval case on `main` of `intents`), `towercab.escapes` (counter, once per merged change found broken after merge; `where` = `e2e`/`alert`). **Change failure rate** = `escapes` ÷ merged intents (`intent.duration` with `outcome` in `done`, `reverted`, `revert_failed`), per week. | test_test_metrics, test_change_failure_rate |
| MET-26 | **Deploy:** `towercab.review.findings` (counter; `pass`, `policy` (skill name or `none`), `severity`, `path` = `auto`/`approval`), `towercab.review.first.duration` (histogram; PR ready → first review), `towercab.feedback.rounds` (counter; `resolved_by` = `worker`/`me`), `towercab.gate.wait.duration` (histogram; `gate` = `spec`, `merge`, `release`, `answer`, `protected`, `other`; replaces human wait), `towercab.guard.blocks` (counter; `kind` = `protected`/`test_lock`), `towercab.gate.violations` (counter; a Towercab merge whose `merge^1..merge` diff touches a [REPO-8](repo.md) path not in `unlock`; target 0), `towercab.ci.triage` (counter; `by` = `worker`/`me`), DORA: `towercab.deploys` (counter; `env` = `staging`/`production`), `towercab.change.lead.duration` (histogram; first commit → production deploy seen: the release deploy ([PIP-34](pipeline.md)) if the repo has one, else `live`), `towercab.restore.duration` (histogram; e2e red → green again). | test_deploy_metrics |
| MET-27 | **Maintain:** `towercab.breaches` (counter; `band`, `tier`), `towercab.breach_to_intent.duration` (histogram; breach → draft intent PR), dismissals via `towercab.intent.drafts{source="alert",result="rejected"}`. | test_maintain_metrics |

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
