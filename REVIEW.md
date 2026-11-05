# Review

How a PR on Towercab is reviewed (REPO-4). Towercab reads this from `main`.

## Passes

- **Bugs**: wrong behaviour, unhandled errors, crashes on bad input, races between git, child
  processes and the loop; tests that pass without checking the behaviour.
- **Security**: secrets or tokens in logs, prompts, commits, comments or child environments; shell
  injection through titles, branch names or config; paths escaping a checkout; network where the
  sandbox should have none.
- **Compliance**: every changed spec row's behaviour is built and its `Verified by` tests check it;
  Status lines say what is live; nothing is built outside the rows and the plan.

## What Important means here

A finding is Important when it can lose or overwrite an intent or the owner's edits, merge or stop
the wrong thing, leak a secret, or leave the loop stuck or crash-looping. Everything else is a nit,
including test titles missing from `Verified by`, missing screenshots, Status-line wording, small
differences from the plan and edge cases that fail safe. Report only Important findings.

## Cap the nits

0 nits per review: leave out nits and minor issues.

## Do not report

- Style that Biome already enforces.
- Missing doc comments on unexported functions.

## Red lines

- `src/machine.ts`: the state machine; a wrong move merges, stops or loses work silently.
- `src/pipeline/guard.ts` and `src/claude.ts`: the worker's sandbox and access.
