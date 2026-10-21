# Towercab

Majid's software factory: intents in the `intents` repo → Claude Code builds them → PRs.
Being rewritten in Rust (crate at the root). The Python package (`towercab/`, `bin/towercab`,
`tests/*.py`) keeps running until the pipeline intent switches over; don't extend it.

## Commands

- `cargo test --locked`, `cargo clippy --all-targets --locked -- -D warnings`, `cargo fmt`
- `cargo run -- add "towercab: <title>" u3 i4` · `migrate` · `review` · `--home /tmp/tc run [--watch]` · `--version`
- `python3 -m unittest discover -s tests`: the Python version's tests
- Machine with a zig `cc`: `export CRATE_CC_NO_DEFAULTS=1` before cargo

## Conventions

- `specs/*.md` are the truth. Behaviour changes start with a spec row; update the row,
  its `Verified by` and the Status line (`Live: …`) in the same commit as the code.
- Every `test_*` named by a Live row exists as `fn test_…` (`tests/spec_refs.rs`, PIP-12).
- Logic in `src/lib.rs` modules, all `pub`; `src/main.rs` only calls `towercab::cli::run`.
- Tests only in `tests/*.rs` (no `#[cfg(test)]` in `src/`); shared fixtures in `tests/common/`.
- Tests are hermetic: temp dirs, local bare git repos, fake `gh`/`claude` on `PATH`.
  Never the network, GitHub or `~/.local/share/towercab`.
- Errors are `String`s that read as the reason; no `anyhow`, no async. Git through the `git` CLI.
- Conventional Commits, small commits.

## Architecture

- `src/cli.rs`: clap; errors → `towercab: <reason>`, exit 1; bad arguments 2. `config.rs`: **Config**.
- The loop, file → interface in loop.md **Code**: `home.rs`, `db.rs` (**Schema**; `Db::tx` = one
  `BEGIN IMMEDIATE`), `runloop.rs` (5 s pass; so far `commands`), `commands.rs`, `service.rs`,
  `exes.rs`, `handler.rs` (picks off). Next: `machine.rs`, the one state machine (a red line).
- `src/priority.rs`: `2i + u`, order, parked, `pick_order`, `review_due` (PRI-7/8), `parse_scores`.
- `src/review.rs`: `towercab review` (injected IO; each answer one `Store::update`; `shown` masks).
- `src/intents/`: the intent home. `intent.rs` (parse, typed fields, line-level `set`),
  `id.rs`, `store.rs` (`Store`: list/get/add/update, pull → write → commit → push, replay
  on rejection), `views.rs` (generated `TODO.md`/`DONE.md`), `git.rs`, `migrate.rs`.
- `src/repo/`: a target repo's `CLAUDE.md`/`REVIEW.md`/`TOWERCAB.md` from `origin/<base>`
  (`load`, pure `parse`), protected paths (`protected.rs`), `protect` (rulesets via my `gh`).

## Things Claude gets wrong here

- Editing `TODO.md`/`DONE.md` in `intents`: they are generated; edit `intent.md` files.
- Re-serialising front matter: write with `Intent::set`/`remove` so other lines stay byte-identical.
- Adding a test name to a spec row without the `fn`, or marking a row Live before it is built.
- `std::env::set_var` in a test binary that has other tests: give it its own `tests/*.rs`.
- One change's writes outside one `Db::tx`; the binary in a test without `common::towercab` + `--home`.
- Writing to the Python package or its tests for Rust work.

## Verifying your work

```setup
cargo fetch --locked
```

```checks
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
python3 -m unittest discover -s tests
```
