# Towercab

Personal software factory. One central task list ([gradient-tasks](https://github.com/MajidBabaeifar/gradient-tasks)); agents pick tasks by
priority, validate, push, and report how they did.

**Status:** reads the task list, delegates, waits out limits, opens PRs, loops. The rest of the design: [specs/](specs/README.md).

**CI:** GitHub Actions (`.github/workflows/ci.yml`) runs `python3 -m unittest discover -s tests` on Python 3.12 for every PR and push to `main`; a failing test turns the check red. See [PIP-12](specs/pipeline.md).

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

2. Install once (links `towercab` into `~/.local/bin`; make sure that is on `PATH`):

   ```bash
   ./install.sh
   ```

3. Then, from any folder:

   ```bash
   towercab doctor          # git, gh, claude, sandbox (bwrap, socat), systemd-inhibit, config
   towercab --version       # print version
   towercab next            # what it would run, and why
   towercab run --watch     # work down the list; Ctrl-C stops cleanly
   towercab run --task 1715 # just this one task (ID or unique suffix), even if [!]
   towercab up              # run --watch, laptop kept awake
   ```

`towercab up [--max-tasks N] [--task ID]` runs the same loop under
`systemd-inhibit --what=sleep:idle:handle-lid-switch --mode=block`. Sleep, idle and
lid-close are blocked only while it runs; Ctrl-C stops the loop and releases them.
Lid inhibit depends on your logind/polkit policy. Needs systemd; otherwise use `run --watch`.

Each task: marked `[~]`, built in its own checkout (one session plans, implements, writes tests
and docs), pushed as `towercab/<id>-<slug>` with a PR right away, then CI (`gh pr checks`) is the
gate: red sends the failing logs back to the same build session and pushes again (max 3, then
`[!]` + question + Telegram). Green → reviewer agent; the task becomes `[!]` with `pr:` until you merge,
then moves to `DONE.md` with cost, time and attempts. Blocked or unknown-repo tasks become
`[!]` with a question in `tasks/<id>.md`; set them back to `[ ]` to retry. Agent access and
limit handling: [specs/runner.md](specs/runner.md).

## Telegram notifications

Optional. Towercab messages you when a PR is ready, a task is stuck or asking, CI stays red, a usage limit
makes it wait (with the reset time), and when a task is merged.

1. In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, follow the prompts, copy the token.
2. Send your new bot any message, then open `https://api.telegram.org/bot<token>/getUpdates` and copy `chat` → `id`.
3. Add to `config.toml`:

   ```toml
   [telegram]
   bot_token = "123456:ABC..."
   chat_id = "123456789"
   ```

A failed send (offline, bad token) is logged once and ignored; the loop never stops for it.

### Commands from your phone

While `towercab run --watch` (or `towercab up`) is running, message the bot from the configured chat:

| Command | Does |
|---|---|
| `status` | running task, tasks waiting on you, next task, limit cooldowns |
| `next` | same as `towercab next` |
| `approve <id>` | `[!]` → `[ ]` (clears `note`, keeps `pr:`), pushed |
| `run <id>` | start that task now, even if `[!]`; refused while another is in flight |

`<id>` is the full ID or a unique suffix. Messages from other chats are ignored. Commands are polled once
per loop pass, so during a long stage they are answered when that step ends.

## Missions by hand (the original MVP)

Imported from my earlier `local agent` prototype. It predates the specs above.

For a first useful product, follow [Pocket Notes setup and monitoring](examples/pocket-notes/RUN.md).

A dependency-free Python MVP for Linux/macOS. Queue a new product or a change to
an existing Git repository. A persistent scheduler runs **build → verify → review**,
feeding failed checks/review findings back into a bounded repair loop. Claude repairs
resume the build session (`claude --resume <session_id>`); Codex repairs start fresh.

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
- `missions/ID/build.txt`, `review.txt`, `changes.patch`, `report.json`: evidence.

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
- Codex uses workspace-write for building and read-only for review, with
  approvals disabled (requests requiring approval fail). Claude uses explicit tool
  allowlists and dontAsk. Claude Bash and verification are **not OS sandboxes**;
  use trusted projects. Full permission bypass flags are never used.
- The host must stay awake and connected for real agent work. `towercab up` blocks
  sleep only while it runs. No background service; power settings are not changed.
- Review is text-based. Browser interaction, product memory and
  long-running product discovery are not implemented in this first slice.

CLI references: [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
and [Claude Code programmatic mode](https://code.claude.com/docs/en/headless).
