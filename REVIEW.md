# Review

How a PR on Towercab is reviewed (REPO-4). Towercab reads this from `main`.

## Passes

- **Bugs**: wrong behaviour, unhandled errors, panics on bad input, races between git,
  child processes and the loop; tests that pass without checking the behaviour.
- **Security**: secrets or tokens in logs, prompts, commits or child envs; shell injection
  through titles, branch names or config; paths escaping a checkout; network in sandboxed steps.
- **Compliance with the spec rows and `plan.md`**: every changed row's behaviour is built and its
  `Verified by` tests check it; Status lines say what is live; nothing built outside the rows.

## What Important means here

A finding is Important when it can lose or overwrite an intent or my edits, merge, deploy or
revert the wrong thing, leak a secret, or leave the loop stuck or crash-looping. Everything else is a nit.

## Cap the nits

5 nits per review, most useful first.

## Do not report

- Style `cargo fmt` and `clippy -D warnings` already enforce.
- Missing docs on private items.

## Red lines

- `src/machine.rs`: the state machine; a wrong transition merges, reverts or stops work silently.
- `ops/**`: Grafana, telemetry and band thresholds that judge Towercab itself.
