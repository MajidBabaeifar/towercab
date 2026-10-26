---
max_autonomy: 5
protected: [src/machine.ts]
tests: [tests/**, ui/*.spec.ts]
---

# Towercab on Towercab

What Towercab needs to know about its own repo (REPO-1, REPO-6).

- `max_autonomy: 5`: Towercab may merge its own PRs when the gate allows.
- `protected`: the state machine; a worker can't write it unless the plan grants it (REPO-8).
- `tests`: the red→green proof lays these over the base branch (PIP-30).
- Towercab runs on the owner's machine from this checkout and updates itself after a merge
  (LOOP-35).
