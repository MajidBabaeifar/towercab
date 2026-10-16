# Specs

The **task list is the source**. A spec is written or changed when a task is picked up,
not ahead of it.

1. Task arrives from `gradient-tasks` ([tasks.md](tasks.md)).
2. Before code: add or change the requirement rows it touches in that area's spec.
   New area → copy `_template.md`.
3. One requirement = one testable line. IDs never reused; dropped → `Removed`.
   `Verified by` = test name, command, or `manual` (say what to look at).
4. Spec, code and tests in the same commit. PR body lists the IDs.

Short but technical: interfaces, fields, formulas, limits. ~30 lines per spec.
`Draft` = agreed, not built; `Verified by` then names the planned check.

| Spec | Prefix | Covers |
|---|---|---|
| [priority.md](priority.md) | PRI | Scores, order, cutoff, review |
| [autonomy.md](autonomy.md) | AUT | Where a task waits for me |
| [scheduler.md](scheduler.md) | SCH | Removed: superseded by loop.md |
| [tasks.md](tasks.md) | TSK | Task format, IDs, `gradient-tasks` repo |
| [metrics.md](metrics.md) | MET | OTLP metrics and events, Claude Code telemetry, Grafana dashboard |
| [runner.md](runner.md) | RUN | Removed: superseded by loop.md |
| [pipeline.md](pipeline.md) | PIP | Build, verify, publish, CI, gate, review, human, merge, deploy, e2e, revert |
| [loop.md](loop.md) | LOOP | Rust runner: service, state machine, crash recovery, limits, status, Telegram, commands |
| [repo.md](repo.md) | REPO | `TOWERCAB.md` per repo: setup, checks, live + e2e, red lines; `protect` |
