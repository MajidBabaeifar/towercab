---

max_autonomy: 5
protected: [src/machine.rs, ops/bands.yaml]
tests: [tests/**]
---

# Towercab on Towercab

What Towercab needs to know about its own repo that has no playbook home (REPO-1).
- `max_autonomy: 5`: Towercab may merge its own PRs when the gate allows.
- `protected`: the state machine and the bands Towercab is judged by; the worker can't write
  them unless an intent's `unlock` names them (REPO-8).
- `tests`: the red→green proof lays these over the base branch (PIP-30).
- No `live` block: Towercab runs on the owner's machine; merged means done until it deploys itself.
