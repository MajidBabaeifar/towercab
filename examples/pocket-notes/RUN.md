# Build Pocket Notes with the factory

This is a real agent mission, not the deterministic factory demo. It creates a
local Python notebook CLI with SQLite storage, tags, search, archiving and export.
The application will be built when you start the scheduler.

## 1. Prepare (safe to repeat)

```bash
cd ~/Repositories/towercab
python3 -m towercab doctor
python3 examples/pocket-notes/queue.py
python3 -m towercab --home .towercab-pocket-notes status
```

Copy the printed mission ID for the monitoring commands below. The dedicated
queue separates this run from the earlier hello-world mission. Codex handles
both implementation and review; Claude isn't required for this first product.

## 2. Run in terminal A

```bash
cd ~/Repositories/towercab
python3 -m towercab --home .towercab-pocket-notes run --missions-only --watch --timeout 1200
```

Keep this terminal open. Each stage has a 20-minute timeout and the mission has
three repair rounds. `--watch` waits out rate-limit cooldowns and remains idle
after completion; stop it with Ctrl-C once you are done. Laptop suspension pauses
local execution. No automatic merge, deployment, or paid API fallback is used.

## 3. Monitor in terminal B

Replace MISSION_ID with the ID printed by setup:

```bash
cd ~/Repositories/towercab
python3 -m towercab --home .towercab-pocket-notes logs MISSION_ID --follow
```

This prints Codex messages, executed commands, their output, stage changes, and
final feedback. It automatically follows newly created stage log files. Ctrl-C
here stops only monitoring. Full unfiltered logs remain on disk.

For a compact view of stages and provider cooldowns, use another terminal:

```bash
watch -n 2 'python3 -m towercab --home .towercab-pocket-notes status'
```

For detailed state and event history:

```bash
python3 -m towercab --home .towercab-pocket-notes show MISSION_ID
```

`queued` means waiting to run (or cooling down), `running` identifies the active
stage, `ready` means checks passed and the reviewer approved, and `blocked` means
you need to inspect feedback/logs. `ready` is not a guarantee of perfect software.

If blocked, stop the scheduler before retrying (it owns the queue lock). Fix the
reported problem, then use `retry MISSION_ID` and restart `run --watch`. The retry
does not reset the repair budget. Review findings and logs before retrying.

## 4. Try the generated application when ready

```bash
cd ~/Repositories/towercab/.towercab-pocket-notes/missions/MISSION_ID/workspace
python3 notes.py --help
python3 notes.py add 'First factory product' --body 'Built by my local factory' --tag projects
python3 notes.py list
python3 notes.py search factory
python3 notes.py export --output notes.md
python3 -m unittest discover -s tests -v
python3 '/home/majid/Repositories/local agent/examples/pocket-notes/verify.py'
```

The default app database is `~/.local/share/pocket-notes/notes.sqlite3`. To use a
scratch database, put `--db /tmp/my-pocket-notes.sqlite3` before each subcommand.

Inspect `changes.patch`, `review.txt`, and `report.json` in the mission directory
above `workspace`. Acceptance checks cover CLI behavior, persistence, validation,
search, archive/restore and export. Human usability/code quality still depend on
review. The factory runs the external acceptance checker; run the generated unit
tests yourself as shown above if you want to double-check the agent's report.
