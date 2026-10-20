# Maintain

**Status:** Draft (Rust rewrite) · **Prefix:** MNT

## Purpose

Stage 6 of the playbook, closing the loop: deterministic code watches Towercab's own process
metrics; a breach is diagnosed by Claude and comes back as an intent I triage.

## Requirements

| ID | Requirement | Verified by |
|---|---|---|
| MNT-1 | **Bands** live in `ops/bands.yaml` in the Towercab repo (protected, [REPO-6](repo.md); changed by PR), the playbook's shape: per band `metric` (name), `query` (PromQL against `[metrics].prometheus`), `period` (default `1d`), `baseline` (default `rolling_30d`), `rules: western_electric` (only value), optional `repo`, and `tiers`: `1sigma: {action: log}`, `2sigma: {action: diagnose}`, `3sigma: {action: propose, routes: [pull_request, runbook:cap_repo \| runbook:pause]}`. Evaluated once per completed `period`. | test_parse_bands |
| MNT-2 | **Default bands** (Towercab's process only, MET series with `sum_over_time`): `ci_failure_rate` = `ci.result{result="red"}` ÷ all `ci.result` per day (days without CI skipped); `cycle_time` = p50 of `intent.duration{kind="cycle"}` (picked → done) per day; `cost_per_intent` = p50 of `intent.cost` per day; `change_failure_rate` ([MET-25](metrics.md)) per week, `baseline: rolling_182d`; `eval_pass_rate` = `eval.pass_rate` per run, `baseline: rolling_182d`. | test_default_bands |
| MNT-3 | **Detection is pure code, no model:** each completed period, the query (range, step = `period`) over the baseline window; mean and σ come from the points before the newest 8. Western Electric on the newest points: newest beyond 3σ → `3sigma`; 2 of the last 3 beyond 2σ on the same side → `2sigma`; 4 of the last 5 beyond 1σ on the same side, or the last 8 on the same side of the mean → `1sigma`. Fewer than 14 baseline points → no verdict. One breach event per (band, tier, newest point): band, tier, value, mean, σ ([MET-18](metrics.md)). | test_western_electric_rules, test_short_baseline_no_verdict, test_breach_once_per_point |
| MNT-4 | **`1sigma`:** log only. | test_tier_log |
| MNT-5 | **`2sigma`** (`action: diagnose`): a fresh Claude run (review model, `--tools ""` as the drafter, [PIP-24](pipeline.md)) given the series, the band, recent events and PRs, and the last 5 `lessons/` (code gathers them) returns `--json-schema` `{title, problem, evidence, outcome, affected, open_questions, u, i, why_u, why_i}`; Towercab writes `intent.md` from it (`started` = breach time) as a draft intent PR on `intents` ([INT-8](intents.md)), `source: alert:<band>`. One open draft per band: a new breach comments on it instead. | test_diagnosis_drafts_intent, test_one_draft_per_band |
| MNT-6 | **`3sigma`** (`action: propose`): the `pull_request` route = as `2sigma`; then each `runbook:<name>` in `routes`, run in code: `cap_repo` (repo autonomy cap 3, as [AUT-10](autonomy.md), cleared by `trust`) or `pause` (no picks until `resume`). Message `triage: <band> at 3σ` ([LOOP-14](loop.md)). | test_runbook_cap_repo, test_runbook_pause |
| MNT-7 | **Triage** is the intent PR: merge = fix accepted (it runs like any intent), close = dismissed. Dismissals are counted per band and shown in `status`; I tune `bands.yaml` myself. | test_dismissal_counted |
| MNT-8 | **Lessons:** when an intent with `source: alert:*` is done, Towercab writes `lessons/<yymmdd>-<slug>.md` in `intents` (anomaly, cause, fix PR, the band's first value after the fix and whether it is back within 1σ, eval case) with the writer ([PIP-11](pipeline.md)). Its eval case is marked `incident: true` and always replayed ([PIP-33](pipeline.md)); so is the case of an intent reverted ([PIP-19](pipeline.md)) or left at `e2e red after your merge` ([PIP-20](pipeline.md)). | test_lesson_written, test_incident_eval_always_replayed |

## Out of scope

- Live services' own metrics and scheduled e2e ([PIP-10](pipeline.md)): offered, not chosen.
- Slack and Claude Tag: Telegram is the channel ([LOOP-14](loop.md)).
- Changing bands automatically from dismissals.

## Decisions

- Towercab's own process only (my call): its metrics are already in Prometheus; services come later.
- Playbook tiers (my call): detection deterministic; Claude only diagnoses; the only actions at 3σ are
  pre-approved, reversible runbooks.
- A breach becomes an intent PR, never a runnable intent: nothing a machine writes runs without my merge.
