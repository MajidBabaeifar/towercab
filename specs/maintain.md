# Maintain

**Status:** Draft (Rust rewrite) · **Prefix:** MNT

## Purpose

Stage 6 of the playbook, closing the loop: deterministic code watches Towercab's own process
metrics; a breach is diagnosed by Claude and comes back as an intent I triage.

## Requirements

| ID | Requirement | Verified by |
|---|---|---|
| MNT-1 | **Bands** live in `ops/bands.yaml` in the Towercab repo (a protected path, changed by PR): per band `metric` (name), `query` (PromQL against `[metrics].prometheus`, default `http://localhost:9090`), `every` (default 1 h), `baseline` (default `rolling_30d`), optional `repo`, and `tiers` (`1sigma`, `2sigma`, `3sigma` → `log`, `diagnose`, or `diagnose` + `runbook`). | test_parse_bands |
| MNT-2 | **Default bands** (Towercab's process only): `ci_failure_rate` (CI red share per day), `cycle_time` (picked → merged, p50 per day), `cost_per_intent` (per day), `change_failure_rate` (reverted ÷ merged, per week), `eval_pass_rate` (per run). | test_default_bands |
| MNT-3 | **Detection is pure code, no model:** each `every`, the query's series over the baseline window gives mean and σ; Western Electric rules: 1 point beyond 3σ → tier `3sigma`; 2 of 3 beyond 2σ on one side → `2sigma`; 4 of 5 beyond 1σ, or 8 in a row on one side → `1sigma`. Fewer than 14 points → no verdict. Every breach is an event (band, tier, value, mean, σ; [MET-18](metrics.md)). | test_western_electric_rules, test_short_baseline_no_verdict |
| MNT-4 | **`1sigma`:** log only. | test_tier_log |
| MNT-5 | **`2sigma`:** read-only diagnosis: a fresh Claude run (review model, review access, [PIP-24](pipeline.md)) given the series, the band, recent events and PRs, and the last 5 `lessons/` (code gathers them; Claude has no network) writes an `intent.md` (anomaly and evidence as Problem, proposed outcome, affected systems, open questions) → draft intent PR on `intents` ([INT-8](intents.md)), `source: alert:<band>`, `u`/`i` proposed. One open draft per band: a new breach comments on it instead. | test_diagnosis_drafts_intent, test_one_draft_per_band |
| MNT-6 | **`3sigma`:** as `2sigma`, then the band's `runbook` if it names one, run in code: `cap_repo` (repo autonomy cap 3, as [AUT-10](autonomy.md), cleared by `trust`) or `pause` (no picks until `resume`). Message `triage: <band> at 3σ` ([LOOP-14](loop.md)). | test_runbook_cap_repo, test_runbook_pause |
| MNT-7 | **Triage** is the intent PR: merge = fix accepted (it runs like any intent), close = dismissed. Dismissals are counted per band and shown in `status`; I tune `bands.yaml` myself. | test_dismissal_counted |
| MNT-8 | **Lessons:** when an intent with `source: alert:*` is done, Towercab writes `lessons/<yymmdd>-<slug>.md` in `intents` (anomaly, cause, fix PR, eval case) with the writer ([PIP-11](pipeline.md)); its eval case is marked `incident: true` and always replayed ([PIP-33](pipeline.md)). | test_lesson_written, test_incident_eval_always_replayed |

## Out of scope

- Live services' own metrics and scheduled e2e ([PIP-10](pipeline.md)): offered, not chosen.
- Slack and Claude Tag: Telegram is the channel ([LOOP-14](loop.md)).
- Changing bands automatically from dismissals.

## Decisions

- Towercab's own process only (my call): its metrics are already in Prometheus; services come later.
- Playbook tiers (my call): detection deterministic; Claude only diagnoses; the only actions at 3σ are
  pre-approved, reversible runbooks.
- A breach becomes an intent PR, never a runnable intent: nothing a machine writes runs without my merge.
