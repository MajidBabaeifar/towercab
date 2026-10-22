# Towercab

Majid's software factory: intents in the `intents` repo → Claude Code builds them → PRs.
One Rust crate at the root; the Python version lives on branch `python`.

## Commands

- `cargo test --locked`, `cargo clippy --all-targets --locked -- -D warnings`, `cargo fmt`
  (a machine with a zig `cc`: `export CRATE_CC_NO_DEFAULTS=1` first)
- `cargo run -- add "towercab: <title>" u3 i4` · `migrate` · `review` · `--home /tmp/tc run [--watch]` · `status` · `doctor`
- `python3 -m unittest discover -s tests`: `tests/test_ops.py` (the `ops/` scripts, until the metrics intent ports them)

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
- The loop (file → interface: loop.md **Code**): `runloop.rs` (5 s pass), `machine.rs` (the one state machine,
  a red line), `mission.rs`, `handler.rs` (`Handler`, `Ctx::record`; `production()` = the pipeline), `pick.rs`, `checkout.rs`,
  `events.rs`, `child.rs`, `limits.rs`, `env.rs`, `awake.rs`, `home.rs`, `db.rs` (`Db::tx` = one `BEGIN IMMEDIATE`),
  `commands.rs`, `outbox.rs`, `telegram.rs` (`http.rs`), `status.rs`, `doctor.rs`, `service.rs`, `exes.rs`; subsets: `github`, `claude`.
- `src/priority.rs`: PRI order, `pick_order`, `review_due`; `src/review.rs`: `towercab review`. `src/autonomy.rs`: AUT cap, gate, spec gate, `lower_a`.
- `src/intents/`: the intent home: `intent.rs` (parse, line-level `set`), `id.rs`, `store.rs` (`Store`:
  list/get/add/update; pull → write → commit → push, replay), `views.rs`, `git.rs`, `migrate.rs`.
- `src/repo/`: `CLAUDE.md`/`REVIEW.md`/`TOWERCAB.md` from `origin/<base>` (`load`), `protected.rs`, `protect`.
- `src/pipeline/` (pipeline.md **Code**): a handler per stage, state in `missions.data`, Claude runs (`runs.rs`),
  `evals.rs`, `findings.rs`; `prompts/*.md`; `src/writer.rs` (PR text). Tests: `tests/pipe_*.rs`, `common/pipe.rs`.

## Things Claude gets wrong here

- Editing `TODO.md`/`DONE.md` in `intents`: they are generated; edit `intent.md` files.
- Re-serialising front matter: write with `Intent::set`/`remove` so other lines stay byte-identical.
- Adding a test name to a spec row without the `fn`, or marking a row Live before it is built.
- `std::env::set_var` in a test binary that has other tests: give it its own `tests/*.rs`.
- One change's writes outside one `Db::tx`; in a test, the binary without `common::towercab` + `--home`
  or a `Loop` without `common::fake_exes`/`World::exes` (fixtures: `tests/common/world.rs`, HTTP `http.rs`).
- Moving a mission anywhere but `machine::apply`, or a side effect before its `Ctx::record`.

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
