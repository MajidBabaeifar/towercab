# Towercab

Personal software factory. One central task list ([gradient-tasks](https://github.com/MajidBabaeifar/gradient-tasks)); agents pick tasks by
priority, validate, push, and report how they did.

**Status:** reads the task list, delegates, waits out limits, opens PRs, loops. The rest of the design: [specs/](specs/README.md).

## Target workflow

- Tasks live in `gradient-tasks`, each scored urgency, importance, autonomy (1–5).
- Towercab picks the top runnable task, claims it, runs an agent in its own worktree.
- Validation always runs in full; autonomy decides where the task waits for me.
- `towercab inbox` · `towercab watch <id>` · `towercab review` · `towercab report`

## Run the task list

1. `~/.config/towercab/config.toml` (example: `towercab doctor` prints it if missing):

   ```toml
   [tasks]
   remote = "https://github.com/MajidBabaeifar/gradient-tasks.git"

   [repos.towercab]
   path = "~/Repositories/towercab"
   verify = ["python3", "-m", "unittest", "discover", "-s", "tests"]
   bash = ["python3 -m unittest *", "python3 -m towercab *", "git status*", "git diff*", "ls*", "rg *"]
   ```

2. Then:

   ```bash
   python3 -m towercab doctor          # git, gh, claude, sandbox (bwrap, socat), config
   python3 -m towercab next            # what it would run, and why
   python3 -m towercab run --watch     # work down the list; Ctrl-C stops cleanly
   ```

Each task: marked `[~]`, planned, built, verified and reviewed in its own checkout, then
pushed as `towercab/<id>-<slug>` with a PR; the task becomes `[!]` with `pr:` until you merge,
then moves to `DONE.md` with cost, time and attempts. Blocked or unknown-repo tasks become
`[!]` with a question in `tasks/<id>.md`; set them back to `[ ]` to retry. Agent access and
limit handling: [specs/runner.md](specs/runner.md).

## Missions by hand (the original MVP)

Imported from my earlier `local agent` prototype. It predates the specs above.

For a first useful product, follow [Pocket Notes setup and monitoring](examples/pocket-notes/RUN.md).

A dependency-free Python MVP for Linux/macOS. Queue a new product or a change to
an existing Git repository. A persistent scheduler runs **plan → build → verify →
review**, feeding failed checks/review findings back into a bounded repair loop.

### Try it without an account

From this directory:

```bash
python3 -m towercab doctor
python3 -m towercab --home /tmp/towercab-demo demo
python3 -m towercab --home /tmp/towercab-demo status
python3 -m unittest discover -s tests -v
```

The demo is a deterministic fixture, **not an AI-generated product**. It exercises
the real queue, Git isolation, verification command, stage transitions and report.

### Run an actual mission

Install/login to Codex and/or Claude Code first; the factory reuses their CLI
authentication. `doctor` reports executable availability, not login validity.

```bash
python3 -m towercab add 'First product' \
  --brief examples/hello.md \
  --provider codex \
  --verify '["python3","-c","from hello import greet; assert greet(\"Factory\") == \"Hello, Factory!\""]'
python3 -m towercab run --missions-only
python3 -m towercab status
```

Add `--reviewer claude` for cross-provider review. For an existing project, add
`--repo /absolute/path/to/repo` and supply its real check command. The source must
be clean and have a commit. Committed files are cloned into a separate checkout;
uncommitted/ignored files and installed dependencies are not copied. Submodules
are not initialized automatically. The original checkout is never edited.

`--verify` is an argv JSON array, not shell syntax. For a script use e.g.
`["bash","scripts/check.sh"]`. This command is executed locally with your user's
permissions and should be a check you trust. Agents may edit project tests;
passing a check is evidence, not proof that all requirements are met.

### Operating the queue

```bash
python3 -m towercab run --missions-only --watch --timeout 900
python3 -m towercab show MISSION_ID
python3 -m towercab logs MISSION_ID --follow
python3 -m towercab retry MISSION_ID
```

`run` drains currently eligible work and exits. `--watch` keeps waiting for new
missions and expired provider cooldowns. Ctrl-C stops the active process group
and saves the mission as blocked. Higher `--priority` runs first. Each stage has
a timeout; each mission defaults to two repair rounds (`--max-repairs`).

Rate-limit failures put that provider into persistent exponential cooldown
(60 seconds up to an hour; numeric retry-after can extend it). Other providers'
eligible missions and local verification can proceed. Reset dates in free-form
messages are not parsed yet. Auth, permission, missing executable, and other
errors block a mission for inspection instead of retrying forever. A retry keeps
the repair counter; it does not secretly replenish the budget.

State and evidence live under `~/.local/share/towercab` (`--home PATH`, `TOWERCAB_HOME`):

- `towercab.sqlite3`: missions, events and provider cooldowns.
- `missions/ID/workspace/`: isolated Git checkout and all resulting files.
- `missions/ID/*-STAGE.log`: full process output.
- `missions/ID/plan.txt`, `review.txt`, `changes.patch`, `report.json`: evidence.

Ready means verification passed and the agent reviewer approved. Changes remain
local for human review. There is no automatic merge, push, publishing or deploy.
Inspect the workspace diff before copying/integrating changes into your project.

### Current boundaries

- One active stage at a time across projects. This makes local testing predictable;
  concurrent workers, dependencies and fair scheduling are follow-up work.
- No automatic provider handoff mid-mission. Each provider retains its own queue.
- Process timeouts and repair caps are implemented; token/dollar budgets are not.
- Ordinary restarts preserve queued work/cooldowns. An uncleanly interrupted running
  stage is blocked: ensure orphaned workers have stopped, inspect logs, then retry.
- Codex uses workspace-write for building and read-only for planning/review, with
  approvals disabled (requests requiring approval fail). Claude uses explicit tool
  allowlists and dontAsk. Claude Bash and verification are **not OS sandboxes**;
  use trusted projects. Full permission bypass flags are never used.
- The host must stay awake and connected for real agent work. This MVP does not
  install a background service or change laptop power settings.
- Planning and review are text-based. Browser interaction, product memory and
  long-running product discovery are not implemented in this first slice.

CLI references: [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
and [Claude Code programmatic mode](https://code.claude.com/docs/en/headless).
