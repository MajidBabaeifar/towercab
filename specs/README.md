# Specs

The **intent home is the source**. A spec is written or changed when an intent is picked up,
not ahead of it.

1. An intent arrives in `intents` ([intents.md](intents.md)).
2. Design (Towercab's `design` stage, [PIP-25](pipeline.md)): add or change the requirement rows it touches
   in that area's spec, first commit of the PR. New area → copy `_template.md`.
3. One requirement = one testable line. IDs never reused; dropped → `Removed`.
   `Verified by` = test name, command, or `manual` (say what to look at).
4. Spec, code and tests in the same commit. PR body lists the IDs.

Short but technical: interfaces, fields, formulas, limits. ~30 lines per spec.
`Draft` = agreed, not built; `Verified by` then names the planned check.

| Spec | Prefix | Covers |
|---|---|---|
| [priority.md](priority.md) | PRI | Scores, order, cutoff, review |
| [autonomy.md](autonomy.md) | AUT | Where an intent waits for me |
| [scheduler.md](scheduler.md) | SCH | Removed: superseded by loop.md |
| [maintain.md](maintain.md) | MNT | Bands on Towercab's own metrics, tiers, diagnosis → intent, lessons |
| [intents.md](intents.md) | INT | Intent files, routes in (me, issues, monitoring), acceptance, lifecycle |
| [tasks.md](tasks.md) | TSK | Removed: superseded by intents.md |
| [metrics.md](metrics.md) | MET | OTLP metrics and events, Claude Code telemetry, Grafana dashboard |
| [runner.md](runner.md) | RUN | Removed: superseded by loop.md |
| [pipeline.md](pipeline.md) | PIP | Build, verify, publish, CI, gate, review, human, merge, deploy, e2e, revert |
| [loop.md](loop.md) | LOOP | Rust runner: service, state machine, crash recovery, limits, status, Telegram, commands |
| [repo.md](repo.md) | REPO | `TOWERCAB.md` per repo: setup, checks, live + e2e, red lines; `protect` |
