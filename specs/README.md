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
| [scheduler.md](scheduler.md) | SCH | Picking, claiming, inbox |
| [tasks.md](tasks.md) | TSK | Task format, IDs, `gradient-tasks` repo |
| [metrics.md](metrics.md) | MET | Run records and reports |
| [runner.md](runner.md) | RUN | Config, delegation, agent access, limits, PRs, the loop |
| [pipeline.md](pipeline.md) | PIP | Build, CI, review, risk gate, go live, watch |
| [loop.md](loop.md) | LOOP | Claude Code version: one session, state machine, worker, risk, e2e, revert |
| [repo.md](repo.md) | REPO | `TOWERCAB.md` per repo: checks, live + e2e, red lines |
