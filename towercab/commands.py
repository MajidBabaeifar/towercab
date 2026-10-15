"""Telegram commands from my phone: status, next, approve, run (RUN-22..26)."""
from __future__ import annotations

from datetime import datetime

from .runner import find

HELP = "Commands: status | next | approve <id> | run <id>"


def parse(text):
    """'/Approve@bot 1015-3' -> ('approve', '1015-3')."""
    parts = (text or "").strip().split(None, 1)
    if not parts:
        return "", ""
    cmd = parts[0].lstrip("/").split("@", 1)[0].lower()
    return cmd, parts[1].strip() if len(parts) > 1 else ""


class Commands:
    def __init__(self, runner):
        self.r = runner

    def handle(self, text):
        """Always returns a reply; a failing command never raises into the loop."""
        cmd, arg = parse(text)
        fn = {"status": self.status, "next": self.next, "approve": self.approve, "run": self.run}.get(cmd)
        if not fn or (cmd in ("approve", "run") and not arg):
            return HELP
        try:
            return fn(arg)
        except Exception as exc:
            return f"{cmd} failed: {str(exc).strip()[:300] or type(exc).__name__}"

    def status(self, _=""):
        r = self.r
        doc, _done = r.tasks.read()
        lines = []
        running = [t for t in doc.list() if t.state == "running"]
        lines.append("Running: " + ("; ".join(t.label for t in running) if running else "nothing"))
        waiting = [t for t in doc.list() if t.state == "waiting"]
        if waiting:
            lines.append("Waiting on you:")
            lines += [f"- {t.label} ({t.get('note') or t.get('pr') or 'no note'})" for t in waiting]
        task, why = r.next()
        lines.append(f"Next: {task.label}" if task else f"Next: {why}")
        for row in r.s.db.execute("SELECT * FROM cooldowns"):
            until = datetime.fromtimestamp(row["until"]).astimezone().strftime("%Y-%m-%d %H:%M %Z")
            lines.append(f"{row['provider']} limit until {until}")
        return "\n".join(lines)

    def next(self, _=""):
        task, why = self.r.next()
        return f"{task.label}\n  {why}" if task else why

    def approve(self, ref):
        def change(doc, files):
            try:
                t = doc.get(ref)
            except KeyError:
                return f"No single task matches {ref!r}"
            if t.state != "waiting":
                return f"{t.label} isn't waiting on you"
            t.mark(" ")
            t.set("note", None)
            return t
        result = self.r.tasks.mutate(change, f"Towercab: approve {ref}")
        if isinstance(result, str):
            return result
        return f"approved {result.label}"

    def run(self, ref):
        r = self.r
        try:
            task = r.run_one(ref)
        except ValueError as exc:
            return str(exc)
        mid = r.start(task, force=True)
        return f"{task.label} → mission {mid}" if mid else f"{task.label} not started (see TODO.md)"
