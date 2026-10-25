# Specs

The **intent home is the source**. A spec is written or changed when an intent is picked up,
not ahead of it.

1. An intent arrives in `intents` ([intents.md](intents.md)).
2. Design (Towercab's `design` stage, [PIP-25](pipeline.md)): add or change the requirement rows it touches
   in that area's spec, first commit of the PR. New area → copy `_template.md`.
3. One requirement = one testable line. IDs never reused; dropped → `Removed`.
   `Verified by` = test name, command, or `manual` (say what to look at).
4. Spec rows are the PR's first commit (step 2); code and tests follow in the same PR, squash-merged into one commit. PR body lists the IDs.

Short but technical: interfaces, fields, formulas, limits. ~30 lines per spec.
`Draft` = agreed, not built; `Verified by` then names the planned check.
Status line: `Live: <IDs>` lists the built rows (comma-separated, ranges as `INT-9..13`, up to the next ` · `);
a bare `Live` = every row; otherwise none. Each live row's `test_*` names must exist as `fn` (`tests/spec_refs.rs`, [PIP-12](pipeline.md)).

| Spec | Prefix | Covers |
|---|---|---|
| [priority.md](priority.md) | PRI | Scores, order, cutoff, review |
| [autonomy.md](autonomy.md) | AUT | Where an intent waits for me |
| [scheduler.md](scheduler.md) | SCH | Removed: superseded by loop.md |
| [maintain.md](maintain.md) | MNT | Bands on Towercab's own metrics, tiers, diagnosis → intent, lessons |
| [intents.md](intents.md) | INT | Intent files, routes in (me, issues, monitoring), acceptance, lifecycle |
| [tasks.md](tasks.md) | TSK | Removed: superseded by intents.md |
| [metrics.md](metrics.md) | MET | Playbook indicators, OTLP metrics and events, Claude Code telemetry, Grafana dashboard |
| [runner.md](runner.md) | RUN | Removed: superseded by loop.md |
| [ui.md](ui.md) | UI | Local web page: state, actions, mission pages, run files, log |
| [pipeline.md](pipeline.md) | PIP | Design, spec gate, plan, build, verify, red→green proof, publish, CI, verifier, PR review, gate, merge, deploy, e2e, release, revert, rehearsal, evals |
| [public.md](public.md) | PUB | What a public repo shows: license, security policy, user README, docs index, no personal names |
| [loop.md](loop.md) | LOOP | Rust runner: service, state machine, crash recovery, limits, status, Telegram, commands |
| [repo.md](repo.md) | REPO | `CLAUDE.md` verifying block (setup, checks, run), `REVIEW.md` (passes, red lines), `TOWERCAB.md` (max_autonomy, protected, tests, live, release, rollback); protected paths; `protect` |
