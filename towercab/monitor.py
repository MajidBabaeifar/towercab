"""Read-only mission log viewer; follows new stage files as they appear."""
import json
from pathlib import Path
import time


def readable(line):
    try:
        event = json.loads(line)
    except ValueError:
        return line.rstrip()
    if not isinstance(event, dict):
        return line.rstrip()
    kind = event.get("type", "")
    item = event.get("item") or {}
    if kind.startswith("item."):
        if item.get("type") == "agent_message":
            return item.get("text", "")
        if item.get("type") == "command_execution":
            if kind == "item.started":
                return "$ " + item.get("command", "")
            return f"[command exit {item.get('exit_code')}]\n{item.get('aggregated_output', '')}"
        return f"[{kind}] {item.get('type', '')}"
    if kind == "result":
        return str(event.get("result") or event.get("errors") or event)
    if kind in ("error", "turn.failed"):
        return str(event.get("message") or event.get("error") or event)
    if kind == "turn.completed":
        return f"[turn completed] {event.get('usage', '')}"
    return f"[{kind}]" if kind else line.rstrip()


def logs(store, mid, follow=False):
    offsets = {}
    previous = None
    while True:
        mission = store.get(mid)
        state = (mission["status"], mission["stage"], mission["attempts"])
        if state != previous:
            print(f"\n[{mid}] {state[0]} / {state[1]} / attempt {state[2]}", flush=True)
            previous = state
        folder = store.home / "missions" / mid
        for path in sorted(folder.glob("[0-9]*-*.log")):
            if path not in offsets:
                print(f"\n--- {path.name} ---", flush=True)
                offsets[path] = 0
            with path.open("rb") as f:
                f.seek(offsets[path])
                while True:
                    start = f.tell()
                    line = f.readline()
                    if not line:
                        break
                    # A live JSON event may still be being written.
                    if not line.endswith(b"\n") and mission["status"] == "running" and follow:
                        f.seek(start)
                        break
                    value = readable(line.decode(errors="replace"))
                    if value:
                        print(value, flush=True)
                offsets[path] = f.tell()
        if mission["status"] in ("ready", "blocked"):
            print(f"\n{mission['status'].upper()}: {mission['feedback']}", flush=True)
            if mission["workspace"]:
                print(f"Workspace: {mission['workspace']}", flush=True)
            return
        if not follow:
            return
        time.sleep(1)
