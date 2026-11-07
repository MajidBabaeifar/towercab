# Specs

These files say what Towercab does. They are the source of truth: the code follows them, and a
behaviour change starts here.

## How a spec changes

1. An intent arrives in the `intents` repo ([intents.md](intents.md)).
2. Towercab's design step (or a person) changes the requirements the intent touches, in that area's
   file. A new area starts from [_template.md](_template.md).
3. The change ships as three pull requests: the spec, then the plan, then the code
   ([pipeline.md](pipeline.md)). The code PR marks the rows it built as live.

## How a requirement is written

Each requirement is a `### <ID> · <name>` heading, one plain sentence a person can follow, then the
technical detail under it and how it is verified:

```markdown
### PRI-3 · Priority score

An intent's priority is twice its importance plus its urgency.

- `priority(u, i) = 2 * i + u`, 3–15; missing scores count as 3.
- Verified by: `priority: score is 2i + u`
```

- IDs are never reused. A dropped requirement keeps its heading and says `Removed: <why>`.
- `Verified by` names tests (their exact `test(...)` titles in `tests/`), a command, or `manual` with
  what to look at.
- **Status line:** `Draft` = agreed, not built. `Live: <IDs>` lists the built requirements
  (comma-separated, ranges as `INT-9..13`); a bare `Live` means all of them. Every test a live row
  names must exist (`specs: every live row names tests that exist`).

## Areas

| Spec | Prefix | Covers |
|---|---|---|
| [intents.md](intents.md) | INT | Intent files, IDs, the intents repo, lifecycle fields, generated views |
| [priority.md](priority.md) | PRI | Scores, order, cutoff, dropping |
| [autonomy.md](autonomy.md) | AUT | Where an intent waits for the owner, and what access a worker gets |
| [loop.md](loop.md) | LOOP | The program: service, state machine, crash recovery, limits, commands, messages, updates |
| [pipeline.md](pipeline.md) | PIP | Spec, plan and code PRs; build, verify, proof, CI, review, gate, merge; GitHub interactions; writing |
| [ship.md](ship.md) | SHIP | After the merge: wait for the deploy, run e2e against the live app, roll back and fix forward |
| [repo.md](repo.md) | REPO | What Towercab reads from a target repo: `CLAUDE.md`, `REVIEW.md`, `TOWERCAB.md`; protected paths |
| [gitlab.md](gitlab.md) | GL | Working with code hosted on GitLab: config, token identity, project names, merge requests, approvals |
| [ui.md](ui.md) | UI | The local web page for the person running Towercab |
| [metrics.md](metrics.md) | MET | Cost and time per intent, spend per day |
| [public.md](public.md) | PUB | What the public repo shows: license, security policy, README, screenshot, contributing, conduct, example config, no personal names |
| [shadow.md](shadow.md) | SHD | The shadow: a Claude session the owner talks to in Telegram, what it may do, how it is tagged and capped |
| [telegram.md](telegram.md) | TG | Acting from Telegram: buttons on messages, answering by reply, commands, messages edited when handled |
| [users.md](users.md) | USR | Several people signing in with GitHub, roles, repo access, who did what |
| [observer.md](observer.md) | OBV | The observer: a read-only agent that watches how Towercab runs and proposes improvements as intents |
| [maintain.md](maintain.md) | MNT | Removed: parked as intent 261026-2204-2 |
| [scheduler.md](scheduler.md) | SCH | Removed: superseded by loop.md |
| [tasks.md](tasks.md) | TSK | Removed: superseded by intents.md |
| [runner.md](runner.md) | RUN | Removed: superseded by loop.md |
