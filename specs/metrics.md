# Metrics

**Status:** Draft (Rust rewrite) · **Prefix:** MET

## Purpose

Know how tasks and agent runs go: time per stage, cost, tokens, quality, my effort, limits. In Grafana, from OTLP.

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
| MET-10 | The task's `DONE.md` line shows totals: cost, agent time, attempts ([TSK-6](tasks.md)). | test_done_line |
| MET-11 | Removed: monthly report page; the dashboard's time picker. | — |
| MET-12 | Claude Code's own telemetry. Each Claude run Towercab starts gets `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER=otlp`, `OTEL_LOGS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`, `OTEL_EXPORTER_OTLP_ENDPOINT=<[metrics].endpoint>` (default `http://localhost:4318`), `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta`, `OTEL_METRIC_EXPORT_INTERVAL=30000`, `OTEL_SERVICE_NAME=towercab` (the dashboard's Source filter). For my own sessions, `towercab telemetry on` writes the same vars minus the service name into `env` of `~/.claude/settings.json` (`$CLAUDE_CONFIG_DIR`), other settings kept; `off` removes only those values; `status` prints on/off. Until the Rust binary exists, `ops/telemetry on\|off\|status` does the same. | test_claude_env, test_on_off_keeps_other_settings, test_off_keeps_values_it_did_not_set |
| MET-13 | Towercab's own metrics and events: `src/metrics.rs` sends OTLP/HTTP JSON, delta temporality, resource `service.name=towercab-loop`, to `[metrics].endpoint`. Unreachable → appended to `<home>/metrics.jsonl`; on the next success, metric points are sent stamped with the send time (Prometheus rejects samples older than 10 min), events with their own time. Never blocks or fails the loop. One name list in code; a test checks every dashboard query against it. | test_metric_otlp, test_metric_spool, test_dashboard_names |
| MET-14 | `towercab.stage.duration` (histogram, s), labels `repo`, `stage` ([LOOP-3](loop.md) stages), `result` (`ok`, `red`, `blocked`, `timeout`, `limit`, `crash`, `interrupted`): on every stage exit. | test_stage_metric |
| MET-15 | `towercab.task.duration` (histogram, s), labels `repo`, `outcome` (`done`, `reverted`, `revert_failed`, `blocked`, `closed`, `stopped`), `merged_by` (`towercab`, `human`), `gate` (`a1`..`a5`, `risk_low`, `risk_high`, `capped`); `kind` = `lead` (created → done) and `cycle` (picked → done). | test_task_metric |
| MET-16 | Per Claude run, from its `-p` JSON result: one sample per `modelUsage` key (`model` = key): `towercab.cost.usd` (counter, USD, API-price estimate, from `costUSD`) and `towercab.tokens` (counter, `type` = `input`, `output`, `cache_read`, `cache_creation`, from `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`), labels `repo`, `agent` (`worker`, `review`, `writer`, `triage`), `model`, `stage`. `total_cost_usd` is summed onto the mission for the DONE line (MET-10). | test_run_usage_per_model |
| MET-17 | Counters `towercab.ci.repairs`, `towercab.ci.result` (`result` = `green`, `red`, `flaky`, `none`, `timeout`), `towercab.reverts` (`merged_by`, `result` = `ok`, `failed`), `towercab.usage_limit.waits` and `towercab.usage_limit.wait.duration` (s), labels `model`; histogram `towercab.human.wait.duration` (s), label `repo`. | test_counters |
| MET-18 | `task_id` never a metric label (cardinality); every metric call also writes an OTLP log event with `task_id`, `stage`, `pr` for drill-down in Loki. | test_metric_log_event |
| MET-19 | `docker compose -f ops/docker-compose.yml up -d` runs `grafana/otel-lgtm:0.35.0` on 127.0.0.1 (3000 Grafana, 4317/4318 OTLP), data in volume `lgtm-data`, Prometheus `--enable-feature=otlp-native-delta-ingestion`, retention 400 d. It provisions one overall dashboard `ops/grafana/dashboards/towercab.json` (uid `towercab-overview`, home, no repo filter, refresh picker 10 s–1 d, default 1 m). **Loop:** state, backlog by state. **Tasks:** done, change failure rate, lead p50/p90, cycle p50/p90, cost and tokens per task, auto-merged share, CI repairs per task, CI results, human wait, paused on limit, reverts, finished per interval, time per stage, gate outcomes, cost by agent, stage results, event log (`service_name="towercab-loop"`). **Claude Code usage:** cost, tokens, sessions, active time, cache hit rate, lines, cost by model and main vs subagent, tokens by type, commits, PRs. | test_refresh_picker_and_overall_only, test_panels_well_formed, test_dashboard_names, manual (open Grafana) |
| MET-20 | Gauges every 60 s: `towercab.backlog` (`state` = `runnable`, `parked`, `in_flight`, `waiting_on_me`, `blocked`), `towercab.loop.state` = 1 for the current `state` (`running`, `idle`, `paused`, `env_blocked`, `limit`), 0 for the others. | test_gauges |
| MET-21 | Every histogram uses buckets 5, 15, 30, 60, 300, 900, 1800, 3600, 7200, 14400, 28800, 86400, 172800, 604800 s. | test_buckets |

## Out of scope

- Alerts. Messages come from the loop, only when I must act ([LOOP-14](loop.md)).

## Decisions

- Lead time = created → done; cycle time = picked → done.
- `cost_usd` on a subscription is an API-price estimate, not a bill; the real cost is usage-limit burn.
- Cost and tokens come from each `claude -p` result: exact per run, no transcript parsing or price table.
- Delta temporality end to end: Claude Code's default, and the only kind short processes emit
  correctly. Prometheus stores deltas as-is; queries use `sum_over_time`, never `rate`/`increase`
  (which drop each new series' first sample, i.e. most of a short `claude -p` run). Names matched
  by regex (`claude_code_cost_usage(_USD)?(_total)?`) so OTel→Prometheus suffix rules can't break panels.
- `task_id` never a metric label (cardinality); it lives in events (MET-18).
- OTEL variables for my own sessions live in user settings, not a repo's `.claude/settings.json`:
  Claude Code ignores them there.
- Names follow `towercab.*`; Claude's own stay `claude_code.*`. Claude runs are `service.name=towercab`,
  the loop's own data `towercab-loop`, so Claude's log events don't flood the task event log.
- No `OTEL_RESOURCE_ATTRIBUTES` on Claude runs: Prometheus wouldn't promote them; per-agent and
  per-stage cost comes from MET-16 instead.
