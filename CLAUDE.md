# Towercab

The owner's software factory: intents in the `intents` repo → Claude Code builds them → reviewed PRs.
TypeScript on Node ≥ 22.18, run straight from this checkout (no build step for the program).
v1 (Rust) lives on branch `rust`.

## Commands

- `npm run check` = lint (Biome) + typecheck (`tsc`) + all tests (Vitest); `npm run format` fixes style.
- `npx vitest run tests/<file>` for one file; `npm run test:ui` builds the UI and takes Playwright screenshots.
- `bin/towercab --home /tmp/tc run --watch` runs a loop on a scratch home; `towercab restart` reloads the service.
- `npm run dev:ui` serves the UI with hot reload against the running loop.

## Conventions

- `specs/*.md` are the truth. A behaviour change starts with a spec row; update the row, its
  `Verified by` and the Status line in the same commit as the code. Test titles = `Verified by` names.
- Erasable TypeScript only (no `enum`, `namespace`, parameter properties); relative imports end in `.ts`.
- External programs only through `Tools` (`src/tools.ts`); tests pass `FakeTools` (`tests/helpers/`).
- Tests are hermetic: temp dirs, local bare git repos, fakes for `gh`/`claude`/`bwrap`. Never the network,
  GitHub or `~/.local/share/towercab`. No real sleeps: inject a `TestClock`.
- Errors are `Error`s whose message reads as the reason. Conventional Commits, small commits.
- Text a person reads (PR bodies, comments, questions, UI) follows `prompts/writing.md`.

## Architecture

- `src/cli.ts` → `src/loop.ts` (the 5 s pass). `src/machine.ts` is the one state machine: only `apply`
  moves a mission, in one `Db.tx`. `src/handlers.ts`: the `Handler`/`Ctx` contract.
- `src/pipeline/`: one handler per stage (design → plan → build → verify → proof → publish → ci →
  review → gate → merge), plus sandbox, guard, access, PR text, prompts (`prompts/*.md`).
- `src/intents/`: the intent files and the store (git sync). `src/github/`: App identity, `gh`, PR reads,
  owner events, stage comments. `src/repo/`: `CLAUDE.md`/`REVIEW.md`/`TOWERCAB.md` of target repos.
- `src/ui/`: server, API and view model; `ui/`: the Preact app (Vite).

## Things Claude gets wrong here

- Moving a mission anywhere but `machine.apply`, or a side effect before its `ctx.record`.
- Re-serialising intent front matter: edit with `setField`/`removeField` so other lines stay byte-identical.
- Adding a test title to a spec row without the test, or marking a row Live before it is built.
- Awaiting inside `Db.tx` (it is synchronous on purpose).
- Calling `child_process` directly instead of `Tools`.

## Verifying your work

```setup
npm ci
```

```checks
npm run check
```

```fast
npm run lint
npm run typecheck
npx vitest run {tests}
```

```screenshots
npm run test:ui
```
