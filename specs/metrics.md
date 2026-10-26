# Metrics

**Status:** Draft · **Prefix:** MET

## Purpose

How much each intent costs in money and time, kept where the owner already looks: the intent file,
`DONE.md` and the UI. Exporting metrics to Grafana is parked (intent 261026-2204-5).

## Requirements

### MET-1 to MET-9, MET-11 · v1 run tables and reports

Removed: in v1 already.

### MET-10 · Totals at done

When an intent is done, its file and `DONE.md` show what it cost over all its attempts.

- At `done`: `cost` (sum of the missions' `cost_usd`, 2 decimals), `agent_time` (sum of
  `agent_secs`, seconds), `attempts` ([INT-5](intents.md)); `DONE.md` shows them ([INT-6](intents.md)).
- Verified by: `metrics: totals at done`

### MET-12 to MET-27 · OTLP metrics, dashboard and playbook indicators

Removed: never collected in practice; parked as intent 261026-2204-5.

### MET-28 · Cost and time per run

Every Claude run adds its cost and duration to its mission.

- From the run's result ([PIP-24](pipeline.md)): `total_cost_usd` added to `missions.cost_usd`,
  `duration_ms` / 1000 to `agent_secs`, in the transaction that records the run's end. On `--resume`,
  `total_cost_usd` covers the whole session, so the delta since the session's last recorded total is
  added (`data.session_cost`).
- Verified by: `metrics: run cost is added once`

### MET-29 · Spend per day

The UI shows what Towercab spent today and in the last 7 days, against an optional daily budget.

- Sums of run costs by local day (`data.runs`: `{at, cost}` per run, kept 30 days). `daily_budget_usd`
  set and reached → picks pause until midnight, shown under Problems ([UI-60](ui.md)).
- Verified by: `metrics: spend today and 7 days`, `metrics: daily budget pauses picks`

### MET-30 · Time per step

The intent page shows how long each step took, from the moves.

- Durations = the gaps between consecutive `transitions` of a mission, grouped by stage; waits on the
  owner shown apart from Towercab's own time.
- Verified by: `metrics: time per step from moves`

## Out of scope

- Grafana, OTLP export, Claude Code telemetry, eval pass rates (parked).

## Decisions

- v1 exported dozens of metrics to Grafana that no one read; v2 keeps the three numbers the owner
  asked about (cost, time, spend per day) next to the work.
