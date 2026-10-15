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
| MET-7 | After merge: `pr_url`, `merged_by` (me, baton), `changes_requested`, `ci_after_push`, `reverted_within_7d`. | test_run_after_merge |
| MET-8 | `baton report [--since 7d] [--repo R] [--by model\|repo\|autonomy]`: throughput, lead and cycle time (median, p90), cost per task, first-pass validation rate, revert rate, human wait, top failing checks. | test_report |
| MET-9 | The report suggests raising or lowering `a` per repo from first-pass and revert rates; never applies it. | test_trust_suggestion |
| MET-10 | The task row in the store shows totals: cost, agent time, attempts. | manual |
| MET-11 | Monthly: the report is saved as a page next to the Gradient list, opening the monthly review. | manual |

## Out of scope

- Dashboards. CLI and monthly page first.

## Decisions

- Lead time = created → done; cycle time = claimed → done.
- `cost_usd` on a subscription is an API-price estimate, not a bill.
- Field names map 1:1 to OpenTelemetry GenAI attributes (`gen_ai.usage.input_tokens`, …),
  so export to Grafana or similar later is a mapping, not a rewrite.
- Attributes are a first cut; I'll adjust after real runs.
