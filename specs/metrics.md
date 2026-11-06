# Metrics

**Status:** Live: MET-1..30 · **Prefix:** MET

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

### MET-31 · Budgets

The owner sets a daily and a monthly budget for all of Towercab, and a daily and monthly cap for each repo.

- Four optional amounts in USD (> 0, at most 2 decimals; none = no limit): `daily`, `monthly`, and per
  repo `daily` and `monthly`. Kept in Towercab's own database (`data.budgets`) on this machine, not in
  the repo's `TOWERCAB.md`; a change applies at once, with no PR.
- A day is the local day and a month the local calendar month, as in MET-29. Until the owner saves a
  daily budget, `[agent].daily_budget_usd` is the daily budget; once saved, the saved value wins.
- A repo's spend is the cost of runs of missions of that repo; a part of a multi-repo intent (LOOP-78)
  counts for its own repo. Runs are kept 62 days (was 30) so the month is complete.
- A value that is not a positive number is refused with the reason `a budget is a positive amount in USD`.
- Verified by: `metrics: budgets are saved and read back`, `metrics: the saved daily budget wins over the config`, `metrics: a part's runs count for its own repo`, `metrics: an invalid budget is refused`

### MET-32 · Spend this month and per repo

Towercab can say what it spent this month, and what each repo cost today and this month.

- Sums of `data.runs` by local day, local month and repo, alongside MET-29's; the 7-day and today sums
  are unchanged.
- Verified by: `metrics: spend this month and per repo`

### MET-33 · Reaching a cap pauses work

When a budget or a repo cap is reached, Towercab starts no new work that it would count against it, and says which one.

- Reached = spend ≥ the amount. Daily and monthly budgets stop all picks; a repo's cap stops picks and
  new runs for that repo only. Other repos carry on. This extends MET-29's pause, which is now the
  daily case.
- A run already going finishes its step. Work resumes by itself at local midnight (daily) or on the
  first of the month (monthly), or at once when the owner raises the cap or removes it.
- The pause is recorded once per cap and period as a notice with `{scope: "all" | <repo>, period:
  "day" | "month", spent, cap}`, not once per 5 s pass. Up next gives the reason `daily budget reached`
  or `<repo> reached its monthly cap` in plain words (UI-61).
- Verified by: `metrics: a repo cap pauses only that repo`, `metrics: the monthly budget pauses all picks until the 1st`, `metrics: raising a cap resumes at once`, `metrics: a run in progress finishes its step`, `metrics: a reached cap is noticed once`

### MET-34 · Cost estimate for an intent

Before an intent starts, Towercab estimates what it will cost from what similar intents cost before.

- From the `cost` of the last 10 done intents of the same repo (MET-10): estimate = the median, range =
  the 25th to the 75th percentile, in USD to 2 decimals. Fewer than 3 done intents in the repo → the
  last 10 over all repos; fewer than 3 in all → no estimate (`null`), never a made-up figure.
- The estimate is computed for every intent not yet done, and frozen into the mission when it starts
  (`data.estimate`: `{median, low, high, basis}`, `basis` = `repo` | `all`) so it does not move while
  the intent runs. It is a guide: it never stops or delays work.
- Verified by: `metrics: estimate is the median of the repo's last done intents`, `metrics: estimate falls back to all repos`, `metrics: no estimate with fewer than 3 done`, `metrics: the estimate is frozen at start`

## Out of scope

- Grafana, OTLP export, Claude Code telemetry, eval pass rates (parked).

## Decisions

- v1 exported dozens of metrics to Grafana that no one read; v2 keeps the three numbers the owner
  asked about (cost, time, spend per day) next to the work.
