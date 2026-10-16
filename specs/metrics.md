# Metrics

**Status:** Draft · **Prefix:** MET

## Purpose

Know how each agent run went: time, cost, quality, my effort. Feeds reports and trust.

## Requirements

| ID | Requirement | Verified by |
|---|---|---|
| MET-1 | Every agent run (one session attempt on one task) writes one row to SQLite `runs`. | test_run_row |
| MET-2 | Identity: `run_id`, `task_id`, `attempt`, `repo`, `branch`, `host`, `worker_id`, `provider` (claude-sub, api, local), `model`, effective `a`, `priority` at claim. | test_run_identity |
| MET-3 | Time: `queued_at`, `claimed_at`, `started_at`, `ended_at`; `agent_ms`, `api_ms`, `validation_ms`, `human_wait_ms`. | test_run_time |
| MET-4 | Usage: input, output, cache-read, cache-write tokens; `turns`; `tool_calls`; `cost_usd` (API-equivalent, from the agent's JSON result); `rate_limit_waits`, `rate_limit_wait_ms`. | test_run_usage |
| MET-5 | Outcome: `result` (passed, failed, blocked, timeout, error), `checks_failed`, `repair_rounds`, `reviewer_verdict`, `reviewer_findings`, `autonomy_lowered` + reason. | test_run_outcome |
| MET-6 | Change: `files_changed`, `lines_added`, `lines_removed`, `tests_added`, `spec_ids`. | test_run_change |
| MET-7 | After merge: `pr_url`, `merged_by` (me, Towercab), `changes_requested`, `ci_after_push`, `reverted_within_7d`. | test_run_after_merge |
| MET-8 | `towercab report [--since 7d] [--repo R] [--by model\|repo\|autonomy]`: throughput, lead and cycle time (median, p90), cost per task, first-pass validation rate, revert rate, human wait, top failing checks. | test_report |
| MET-9 | The report suggests raising or lowering `a` per repo from first-pass and revert rates; never applies it. | test_trust_suggestion |
| MET-10 | The task's `DONE.md` line shows totals: cost, agent time, attempts ([TSK-6](tasks.md)). | test_done_line |
| MET-11 | Monthly: the report is saved as `reports/YYYY-MM.md` in `gradient-tasks`, opening the monthly review. | manual |
| MET-12 | Claude Code's own telemetry on: `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER=otlp`, `OTEL_LOGS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`, endpoint `http://localhost:4318`, `OTEL_RESOURCE_ATTRIBUTES=service.name=towercab,host.name=<host>`. Gives `claude_code.token.usage`, `claude_code.cost.usage`, `claude_code.active_time.total` per model. | test_settings |
| MET-13 | `bin/metric` (stdlib Python) sends OTLP/HTTP JSON to the same endpoint; no-op with a stderr line if unreachable, never fails the loop. | test_metric_otlp, test_metric_unreachable |
| MET-14 | `towercab.stage.duration` (histogram, s), labels `repo`, `stage` (LOOP-4 stages), `result` (`ok`, `red`, `blocked`, `timeout`): recorded on every stage exit. | test_stage_metric |
| MET-15 | `towercab.task.duration` (histogram, s), labels `repo`, `outcome` (`done`, `reverted`, `blocked`, `closed`), `merged_by` (`towercab`, `human`), `gate` (`a1`..`a5`, `risk_low`, `risk_high`); lead (created → done) and cycle (picked → done) as `kind`. | test_task_metric |
| MET-16 | Per agent run, `SubagentStop` hook sums usage from the subagent transcript and records `gen_ai.client.token.usage` (histogram, `gen_ai.token.type` input/output/cache_read/cache_creation, `gen_ai.request.model`, `towercab.agent` worker/risk, `repo`) and `towercab.cost.usd` (counter, API list price per model in `bin/prices.json`). | test_subagent_usage |
| MET-17 | Counters: `towercab.ci.repairs`, `towercab.reverts`, `towercab.usage_limit.waits` (+ `towercab.usage_limit.wait.duration`), `towercab.human.wait.duration` (histogram). | test_counters |
| MET-18 | `task_id` never a metric label (cardinality); every metric call also writes an OTLP log event with `task_id`, `stage`, `pr` for drill-down in Loki. | test_metric_log_event |
| MET-19 | `ops/docker-compose.yml` runs `grafana/otel-lgtm` (4317, 4318, 3000); `ops/dashboards/towercab.json` provisioned: throughput, lead/cycle p50/p90, time per stage, cost and tokens per task/model/repo, first-pass CI rate, revert rate, human wait. | manual (open Grafana) |

## Out of scope

- Alerts. Dashboards only; notifications come from the loop ([LOOP-16](loop.md)).

## Decisions

- Lead time = created → done; cycle time = claimed → done.
- `cost_usd` on a subscription is an API-price estimate, not a bill.
- Field names map 1:1 to OpenTelemetry GenAI attributes (`gen_ai.usage.input_tokens`, …),
  so export to Grafana or similar later is a mapping, not a rewrite.
- Attributes are a first cut; I'll adjust after real runs.
- MET-12..19 (Claude Code version): OTel GenAI semantic names (`gen_ai.*`) where one exists,
  `towercab.*` otherwise, so standard Grafana GenAI dashboards work. Built-in telemetry can't
  tell worker from risk agent (`agent.name=custom`) or carry `task_id` in one session: hence own hook.
- MET-1..11 (SQLite `runs`, `towercab report`) belong to the Python version; dropped or
  remapped when the loop replaces it.
