import argparse
import json
from pathlib import Path
import shutil
import sys

from .core import Factory, Store


def main():
    parser = argparse.ArgumentParser(description="Local software factory: plan → build → verify → review")
    parser.add_argument("--home", default=".towercab", help="Persistent Towercab directory")
    sub = parser.add_subparsers(dest="action", required=True)
    sub.add_parser("doctor", help="Check local prerequisites")
    add = sub.add_parser("add", help="Queue a new product or an existing repository mission")
    add.add_argument("title")
    add.add_argument("--brief", type=Path, required=True)
    add.add_argument("--repo", help="Existing clean Git repository; omit to create a new product")
    add.add_argument("--verify", required=True, help='Command as JSON argv, e.g. ["python3","-m","unittest"]')
    add.add_argument("--provider", choices=["codex", "claude"], default="codex")
    add.add_argument("--reviewer", choices=["codex", "claude"])
    add.add_argument("--max-repairs", type=int, default=2)
    add.add_argument("--priority", type=int, default=0)
    run = sub.add_parser("run", help="Process runnable stages, then exit; --watch keeps waiting")
    run.add_argument("--watch", action="store_true")
    run.add_argument("--max-steps", type=int)
    run.add_argument("--timeout", type=int, default=900, help="Seconds per agent/check invocation")
    sub.add_parser("status")
    show = sub.add_parser("show")
    show.add_argument("id")
    log = sub.add_parser("logs", help="Read agent output across all stages")
    log.add_argument("id")
    log.add_argument("--follow", action="store_true", help="Follow new stage logs until ready or blocked")
    retry = sub.add_parser("retry", help="Explicitly retry a blocked mission after inspecting its workspace")
    retry.add_argument("id")
    sub.add_parser("demo", help="Run a deterministic workflow fixture without an LLM")
    args = parser.parse_args()
    try:
        if args.action == "doctor":
            print(f"Python: {sys.version.split()[0]}")
            for exe in ("git", "codex", "claude"):
                print(f"{exe}: {shutil.which(exe) or 'NOT FOUND'}")
            print("Authentication is checked by an actual run. Existing CLI login/config is reused.")
            return
        s = Store(args.home)
        if args.action == "add":
            verify = json.loads(args.verify)
            if not isinstance(verify, list):
                raise ValueError("--verify must be a JSON array")
            s.add(args.title, args.brief.read_text(), args.repo, verify, args.provider,
                  args.reviewer, max_repairs=args.max_repairs, priority=args.priority)
        elif args.action == "run":
            if args.timeout <= 0 or (args.max_steps is not None and args.max_steps <= 0):
                raise ValueError("Timeout and max-steps must be positive")
            Factory(s, args.timeout).run(args.watch, args.max_steps)
        elif args.action == "status":
            for m in s.rows():
                print(f"{m['id']}  {m['status']:8} {m['stage']:6} repairs={m['repairs']}  {'[DEMO] ' if m['demo'] else ''}{m['title']}")
            for r in s.db.execute("SELECT * FROM cooldowns"):
                from datetime import datetime
                print(f"{r['provider']} cooldown until {datetime.fromtimestamp(r['until']).astimezone().isoformat()}")
        elif args.action == "show":
            print(json.dumps(s.get(args.id), indent=2))
            for r in s.db.execute("SELECT message FROM events WHERE mission=? ORDER BY seq", (args.id,)):
                print(r[0])
        elif args.action == "logs":
            from .monitor import logs
            try:
                logs(s, args.id, args.follow)
            except KeyboardInterrupt:
                print("Stopped monitoring; the scheduler is unaffected.")
        elif args.action == "retry":
            with s.lock():
                m = s.get(args.id)
                if m["status"] != "blocked":
                    raise ValueError("Only blocked missions can be retried")
                s.update(args.id, status="queued")
                s.event(args.id, "Explicit retry queued; repair count retained")
        elif args.action == "demo":
            mid = s.add("Hello product", "Create hello.py with greet(name) returning Hello, <name>!",
                        None, [sys.executable,"-c","from hello import greet; assert greet('Factory') == 'Hello, Factory!'"], demo=True)
            Factory(s).run()
            print(f"Demo result: {s.get(mid)['status']}; evidence: {Path(s.get(mid)['workspace']).parent}")
    except KeyboardInterrupt:
        print("Stopped. Mission state is saved.", file=sys.stderr)
        sys.exit(130)
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
