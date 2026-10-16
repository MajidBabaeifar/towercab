"""End to end: the real loop, git and scheduler, with fake `claude` and `gh` executables."""
import json
import re
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from unittest.mock import patch

from towercab.config import Config, RepoConfig
from towercab.core import Factory, Store
from towercab.notify import Notifier
from towercab.runner import Runner, slug
from towercab.taskrepo import TaskRepo
from fake_telegram import FakeTelegram

GIT_ID = ["-c", "user.name=T", "-c", "user.email=t@localhost"]

FAKE_CLAUDE = r'''#!PYTHON
import json, os, pathlib, re, sys
prompt = sys.stdin.read()
if "performing the" not in prompt:   # PR writer (PIP-14)
    if (pathlib.Path(os.environ["FAKE_DIR"]) / "writer_fail").exists():
        sys.exit(1)
    with open(os.path.join(os.environ["FAKE_DIR"], "writer.argv"), "w") as f:
        f.write(" ".join(sys.argv[1:]))
    with open(os.path.join(os.environ["FAKE_DIR"], "writer.prompt"), "w") as f:
        f.write(prompt)
    print("Fake summary\n\n## What changed\n- Fake behaviour")
    sys.exit(0)
stage = re.search(r"performing the (\w+) stage", prompt)[1]
limit = pathlib.Path(os.environ["FAKE_DIR"]) / "limit"
if limit.exists():
    limit.unlink()
    print(json.dumps({"type": "result", "is_error": True, "result": "You've hit your limit · resets 3pm (Europe/Berlin)"}))
    sys.exit(1)
with (pathlib.Path(os.environ["FAKE_DIR"]) / "claude.log").open("a") as f:
    f.write(json.dumps({"argv": sys.argv[1:], "stage": stage, "prompt": prompt}) + "\n")
denials, result = [], "ok"
if stage == "build":
    done = sorted(pathlib.Path(".").glob("done-*.txt"))
    task = re.search(r"Task (\S+) in repo", prompt)[1] if not done else done[0].stem[5:]
    out = pathlib.Path(f"done-{task}.txt")
    out.write_text((out.read_text() if out.exists() else "") + "done\n")   # each build changes something
    if "LEAK" in prompt:
        denials = [{"tool_name": "Read", "tool_input": {"file_path": os.path.expanduser("~/.ssh/id_ed25519")}}]
if stage == "review":
    result = '{"approved": true, "feedback": "looks right"}'
    if (pathlib.Path(os.environ["FAKE_DIR"]) / "review_reject").exists():
        result = '{"approved": false, "feedback": "not good enough"}'
print(json.dumps({"type": "result", "is_error": False, "result": result, "total_cost_usd": 0.01,
                  "duration_ms": 2000, "permission_denials": denials, "session_id": f"sess-{stage}"}))
'''

FAKE_GH = r'''#!PYTHON
import json, os, pathlib, sys
d = pathlib.Path(os.environ["FAKE_DIR"])
args = sys.argv[1:]
with (d / "gh.log").open("a") as f:
    f.write(" ".join(args) + "\n")
if args[:2] == ["pr", "create"]:
    n = len(list(d.glob("pr-*"))) + 1
    (d / f"pr-{n}").write_text(args[args.index("--head") + 1])
    print(f"https://github.com/o/proj/pull/{n}")
elif args[:2] == ["pr", "list"]:
    state = (d / "state").read_text().strip() if (d / "state").exists() else "OPEN"
    head = args[args.index("--head") + 1]
    hits = [p for p in sorted(d.glob("pr-*")) if p.read_text() == head]
    print(json.dumps([{"url": f"https://github.com/o/proj/pull/{p.name[3:]}"} for p in hits] if state == "OPEN" else []))
elif args[:2] == ["pr", "view"]:
    state = (d / "state").read_text().strip() if (d / "state").exists() else "OPEN"
    if "state,headRefName" in args and (d / "view_fail").exists():
        print("error connecting to api.github.com", file=sys.stderr)
        sys.exit(1)
    if "state,headRefName" in args:
        pr = d / f"pr-{args[2].rsplit('/', 1)[-1]}"
        # a PR this fake never created (a hand-written pr: line) reads as closed
        print(json.dumps({"state": state if pr.exists() else "CLOSED", "headRefName": pr.read_text() if pr.exists() else ""}))
    else:
        print(state)
elif args[:2] == ["pr", "checks"]:
    # one result per call from the `checks` queue file: pass, fail, pending, none or stale
    # (a red check from before the push); default pass
    queue = (d / "checks").read_text().split() if (d / "checks").exists() else []
    state = queue.pop(0) if queue else "pass"
    (d / "checks").write_text("\n".join(queue))
    if state == "none":
        print("no checks reported on the 'towercab/x' branch", file=sys.stderr)
        sys.exit(1)
    check = {"name": "tests", "bucket": state, "link": "https://github.com/o/proj/actions/runs/77/job/1"}
    if state == "stale":
        check.update(bucket="fail", startedAt="2000-01-01T00:00:00Z")
    print(json.dumps([check]))
    sys.exit({"pass": 0, "fail": 1, "pending": 8}.get(state, 1))
elif args[:2] == ["run", "view"]:
    print("FAILLOG: test_widget failed (run " + args[2] + ")")
elif args[:2] == ["pr", "edit"] and (d / "edit_fail").exists():
    print("GraphQL: could not update", file=sys.stderr)
    sys.exit(1)
'''


def git(cwd, *args):
    return subprocess.run(["git", "-C", str(cwd), *args], check=True, text=True, capture_output=True).stdout


def script(path, text):
    path.write_text(text.replace("#!PYTHON", f"#!{sys.executable}"))
    path.chmod(0o755)
    return path


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = root = Path(self.tmp.name)
        self.fake = root / "fake"
        self.fake.mkdir()
        script(self.fake / "claude", FAKE_CLAUDE)
        self.gh = script(self.fake / "gh", FAKE_GH)
        env = {"PATH": f"{self.fake}:{os.environ['PATH']}", "FAKE_DIR": str(self.fake)}
        self.env = patch.dict(os.environ, env)
        self.env.start()
        # the code repo Towercab works on
        self.proj = self.bare("proj", {"README.md": "proj\n"})
        self.proj_clone = root / "proj-clone"
        subprocess.run(["git", "clone", "-q", str(self.proj), str(self.proj_clone)], check=True)
        # the task list
        self.tasks_remote = self.bare("tasks", {"TODO.md": "# TODO\n"})
        self.me = root / "me"
        subprocess.run(["git", "clone", "-q", str(self.tasks_remote), str(self.me)], check=True)
        verify = [sys.executable, "-c", "import pathlib,sys; sys.exit(0 if list(pathlib.Path('.').glob('done-*.txt')) else 1)"]
        self.config = Config(tasks_path=root / "tc-tasks", tasks_remote=str(self.tasks_remote), timeout=30,
                             ci_poll=0, ci_grace=0, repos={"proj": RepoConfig("proj", self.proj_clone, verify, ["python3 *"])},
                             source=root / "config.toml")
        self.store = Store(root / "state")
        self.tg = FakeTelegram()
        self.runner = Runner(self.store, self.config, TaskRepo(self.config.tasks_path, self.config.tasks_remote),
                             gh=str(self.gh), out=lambda *a: None,
                             notify=Notifier("tok", "42", self.tg.url, out=lambda *a: None))

    def tearDown(self):
        self.tg.stop()
        self.store.db.close()
        self.env.stop()
        self.tmp.cleanup()

    def bare(self, name, files):
        bare = self.root / f"{name}.git"
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(bare)], check=True)
        seed = self.root / f"{name}-seed"
        subprocess.run(["git", "clone", "-q", str(bare), str(seed)], check=True, capture_output=True)
        for rel, text in files.items():
            (seed / rel).write_text(text)
        git(seed, "add", ".")
        git(seed, *GIT_ID, "commit", "-q", "-m", "seed")
        git(seed, "push", "-q", "origin", "main")
        return bare

    def write_tasks(self, text):
        git(self.me, "pull", "-q")
        (self.me / "TODO.md").write_text(text)
        git(self.me, *GIT_ID, "commit", "-q", "-am", "tasks")
        git(self.me, "push", "-q")

    def todo(self):
        git(self.me, "pull", "-q")
        return (self.me / "TODO.md").read_text()

    def test_three_tasks_back_to_back_then_merged(self):
        self.write_tasks("# TODO\n\n- [ ] proj: First thing\n- [ ] proj: Second thing\n  done when: it works\n"
                         "- [ ] proj: Third thing\n- [!] proj: Waits for me\n")
        self.assertEqual(self.runner.run(), 3)
        todo = self.todo()
        for n, title in enumerate(["First thing", "Second thing", "Third thing"], 1):
            self.assertRegex(todo, rf"- \[!\] \d{{6}}-\d{{4}}(-\d+)? u3 i3 a2 proj: {title}\n(  done when: it works\n)?"
                                   rf"  pr: https://github.com/o/proj/pull/{n}\n  note: review PR")
        self.assertIn("- [!] proj: Waits for me", todo)            # untouched
        branches = git(self.proj, "branch", "--list", "towercab/*")
        self.assertEqual(branches.count("towercab/"), 3)
        self.assertIn("-first-thing", branches)
        files = git(self.proj, "ls-tree", "--name-only", branches.split()[0])
        self.assertRegex(files, r"done-\d{6}-\d{4}")
        # I merge them all
        (self.fake / "state").write_text("MERGED")
        self.runner.check_prs(force=True)
        git(self.me, "pull", "-q")
        done = (self.me / "DONE.md").read_text()
        self.assertEqual(done.count(" · proj#"), 3)
        self.assertRegex(done, r"proj: First thing · proj#1 · \$0\.02 · 0m04s · 1")    # build + review
        self.assertNotIn("First thing", self.todo())
        self.assertIn("Waits for me", self.todo())

    def test_next_explains(self):
        self.write_tasks("- [ ] proj: low u1 i1\n- [ ] 261015-1000 i5 proj: important\n")
        task, why = self.runner.next()
        self.assertEqual(task.title, "important")
        self.assertIn("priority 13", why)

    def test_unknown_repo_asks_instead_of_crashing(self):
        self.write_tasks("- [ ] nowhere: Do a thing\n- [ ] proj: Real one\n")
        self.assertEqual(self.runner.run(max_tasks=1), 1)
        todo = self.todo()
        self.assertRegex(todo, r"- \[!\] \S+ u3 i3 a2 nowhere: Do a thing\n  note: unknown repo")
        task_id = todo.split("- [!] ")[1].split()[0]
        self.assertIn("isn't in", (self.me / "tasks" / f"{task_id}.md").read_text())
        self.assertIn("pr: https://github.com/o/proj/pull/1", todo)

    def test_forbidden_access_blocks_and_asks(self):
        self.write_tasks("- [ ] proj: LEAK the keys\n")
        self.runner.run()
        todo = self.todo()
        self.assertIn("note: blocked at build", todo)
        task_id = todo.split("- [!] ")[1].split()[0]
        self.assertIn("forbidden action", (self.me / "tasks" / f"{task_id}.md").read_text())
        self.assertFalse((self.fake / "pr-1").exists())

    def test_rate_limit_waits_for_reset_and_resumes(self):
        (self.fake / "limit").write_text("1")
        self.write_tasks("- [ ] proj: Patient work\n")
        self.runner.run()
        m = self.store.rows()[0]
        self.assertEqual((m["status"], m["stage"], m["repairs"]), ("queued", "build", 0))
        until = self.store.db.execute("SELECT until FROM cooldowns WHERE provider='claude'").fetchone()[0]
        self.assertGreater(until, time.time())
        events = [r[0] for r in self.store.db.execute("SELECT message FROM events WHERE mission=?", (m["id"],))]
        self.assertTrue(any("waiting until" in e and "not a repair" in e for e in events))
        self.assertIn("- [~]", self.todo())                        # still its task
        self.store.db.execute("DELETE FROM cooldowns")              # the reset time arrives
        self.store.db.commit()
        self.runner.run()
        self.assertIn("pr: https://github.com/o/proj/pull/1", self.todo())

    def test_ctrl_c_leaves_task_waiting(self):
        self.write_tasks("- [ ] proj: Interrupt me\n")
        with patch.object(Factory, "agent", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.runner.run()
        self.assertIn("note: blocked at build", self.todo())

    def test_run_only_one_task(self):
        self.write_tasks("- [!] 261015-1000 proj: Talk first\n  note: talk first\n- [ ] proj: Normal one\n")
        self.assertEqual(self.runner.run(only="1000"), 1)
        todo = self.todo()
        self.assertIn("- [!] 261015-1000 u3 i3 a2 proj: Talk first\n  pr: https://github.com/o/proj/pull/1", todo)
        self.assertIn("- [ ] proj: Normal one", todo)              # not touched
        with self.assertRaises(ValueError):
            self.runner.run(only="9999")

    def test_pr_writer(self):
        self.write_tasks("- [ ] proj: Ship it\n")
        self.runner.run()
        argv = (self.fake / "writer.argv").read_text().split()
        self.assertEqual(argv[:5], ["-p", "--model", "haiku", "--tools", "--output-format"])   # "" drops out of split
        log = (self.fake / "gh.log").read_text()
        create = log[log.index("pr create"):log.index("pr checks")]
        self.assertIn("CI and review are running", create)          # placeholder claims nothing
        self.assertNotIn("Fake summary", create)
        edit = log[log.index("pr edit https://github.com/o/proj/pull/1"):]
        self.assertIn("Fake summary\n\n## What changed\n- Fake behaviour\n\n## Checks", edit)   # final text once ready
        self.assertIn("🤖 Built by Towercab", edit)

    def test_pr_text_edit_failure_never_blocks(self):
        (self.fake / "edit_fail").write_text("1")
        self.write_tasks("- [ ] proj: Ship it\n")
        self.runner.run()
        self.assertIn("note: review PR", self.todo())                 # still ready for me
        events = [r[0] for r in self.store.db.execute("SELECT message FROM events")]
        self.assertTrue(any(e.startswith("PR text not updated: GraphQL") for e in events))

    def test_notify_pr_ready(self):
        self.write_tasks("- [ ] proj: Ship it\n")
        self.runner.run()
        self.assertEqual(len(self.tg.texts), 1)
        self.assertIn("PR ready", self.tg.texts[0])
        self.assertIn("Ship it", self.tg.texts[0])              # title, not just the ID
        self.assertIn("https://github.com/o/proj/pull/1", self.tg.texts[0])
        self.assertEqual([b for p, b in self.tg.calls if p.endswith("/sendMessage")][0]["chat_id"], "42")

    def test_notify_stuck(self):
        self.write_tasks("- [ ] proj: LEAK the keys\n")
        self.runner.run()
        self.assertEqual(len(self.tg.texts), 1)
        self.assertIn("stuck at build", self.tg.texts[0])
        self.assertIn("forbidden action", self.tg.texts[0])

    def test_notify_asking(self):
        self.write_tasks("- [ ] nowhere: Do a thing\n")
        self.runner.run()
        self.assertEqual(len(self.tg.texts), 1)
        self.assertIn("needs you", self.tg.texts[0])
        self.assertIn("nowhere", self.tg.texts[0])
        # publishing fails: gh missing
        self.tg.calls.clear()
        self.write_tasks("- [ ] proj: Cannot publish\n")
        self.runner.gh = str(self.root / "no-such-gh")
        self.runner.run()
        self.assertEqual(len(self.tg.texts), 1)
        self.assertIn("needs you", self.tg.texts[0])
        self.assertIn("Publishing failed", self.tg.texts[0])

    def test_notify_limit_once(self):
        (self.fake / "limit").write_text("1")
        self.write_tasks("- [ ] proj: Patient work\n")
        self.runner.run()
        limits = [t for t in self.tg.texts if "limit" in t]
        self.assertEqual(len(limits), 1)
        until = self.store.db.execute("SELECT until FROM cooldowns WHERE provider='claude'").fetchone()[0]
        stamps = {time.strftime("%Y-%m-%d %H:%M %Z", time.localtime(until + d)) for d in range(-3, 4)}
        self.assertIn("claude", limits[0])
        self.assertTrue(any(s in limits[0] for s in stamps), limits[0])
        # hitting the limit again inside the same wait stays quiet
        (self.fake / "limit").write_text("1")
        self.runner.factory.step(self.store.rows()[0])
        self.assertEqual(len([t for t in self.tg.texts if "limit" in t]), 1)

    def test_notify_merged(self):
        self.write_tasks("- [ ] proj: Merge me\n")
        self.runner.run()
        self.tg.calls.clear()
        (self.fake / "state").write_text("MERGED")
        self.runner.check_prs(force=True)
        self.assertEqual(len(self.tg.texts), 1)
        self.assertIn("merged", self.tg.texts[0])
        self.assertIn("Merge me", self.tg.texts[0])
        self.assertIn("proj#1", self.tg.texts[0])

    def test_dead_telegram_does_not_stop_loop(self):
        self.tg.stop()
        self.write_tasks("- [ ] proj: One\n- [ ] proj: Two\n- [ ] nowhere: Three\n")
        self.assertEqual(self.runner.run(), 2)
        todo = self.todo()
        self.assertIn("pull/1", todo)
        self.assertIn("pull/2", todo)
        (self.fake / "state").write_text("MERGED")
        self.runner.check_prs(force=True)
        self.assertNotIn("One", self.todo())
        self.tg = FakeTelegram()                                  # for tearDown

    # --- publish + CI (PIP-2, PIP-3) -------------------------------------------
    def events(self, mid):
        return [r[0] for r in self.store.db.execute("SELECT message FROM events WHERE mission=? ORDER BY seq", (mid,))]

    def gh_calls(self, prefix):
        log = self.fake / "gh.log"
        return [l for l in (log.read_text().splitlines() if log.exists() else []) if l.startswith(prefix)]

    def gh_edits(self):
        """Every `gh pr edit` call, with its full multi-line body."""
        log = (self.fake / "gh.log").read_text()
        parts = re.split(r"(?m)^(?=pr |run )", log)
        return [p for p in parts if p.startswith("pr edit ")]

    def gh_edit_body(self):
        """Full text of the last `gh pr edit --body` call (bodies span lines in gh.log)."""
        log = (self.fake / "gh.log").read_text()
        return log[log.rindex("pr edit "):]

    def builds(self):
        lines = (self.fake / "claude.log").read_text().splitlines()
        return [c for c in map(json.loads, lines) if c["stage"] == "build"]

    def test_publish_before_review(self):
        # local verify always fails: it no longer gates task missions
        self.config.repos["proj"].verify = [sys.executable, "-c", "raise SystemExit(1)"]
        self.write_tasks("- [ ] proj: Publish early\n")
        self.runner.run()
        m = self.store.rows()[0]
        self.assertEqual(m["status"], "ready")
        started = [e for e in self.events(m["id"]) if e.startswith("Starting ")]
        self.assertEqual(started, ["Starting build", "Starting publish", "Starting review"])
        events = self.events(m["id"])
        self.assertLess(events.index("Pushed; PR https://github.com/o/proj/pull/1"), events.index("Starting review"))
        self.assertIn("pr: https://github.com/o/proj/pull/1\n  note: review PR", self.todo())

    def test_ci_green(self):
        (self.fake / "checks").write_text("pass\n")
        self.write_tasks("- [ ] proj: Green first time\n")
        self.runner.run()
        m = self.store.rows()[0]
        self.assertEqual((m["status"], m["ci_repairs"], m["pr"]), ("ready", 0, "https://github.com/o/proj/pull/1"))
        self.assertIn("CI green", self.events(m["id"]))
        self.assertEqual(len(self.gh_calls("pr checks https://github.com/o/proj/pull/1")), 1)
        review = [c for c in map(json.loads, (self.fake / "claude.log").read_text().splitlines()) if c["stage"] == "review"]
        self.assertIn("CI passed", review[0]["prompt"])
        self.assertEqual(len(self.builds()), 1)

    def test_ci_pending_polls(self):
        (self.fake / "checks").write_text("pending\npending\npass\n")
        self.write_tasks("- [ ] proj: Slow CI\n")
        self.runner.run()                                        # no --watch: still waits out the pending CI
        m = self.store.rows()[0]
        self.assertEqual(m["status"], "ready")
        self.assertEqual(len(self.gh_calls("pr checks")), 3)
        self.assertEqual(m["attempts"], 3)                       # build, publish, review: polls aren't stages

    def test_no_checks_grace(self):
        m = {"pr": "https://github.com/o/proj/pull/1", "remote": "", "published": time.time()}
        self.config.ci_grace = 3600
        (self.fake / "checks").write_text("none\nstale\nnone\n")
        self.assertEqual(self.runner.checks(m)[0], "pending")    # checks not registered yet
        self.assertEqual(self.runner.checks(m)[0], "pending")    # previous commit's red doesn't count
        m["published"] = time.time() - 7200
        self.assertEqual(self.runner.checks(m), ("pass", "No CI checks on this PR."))   # repo without CI
        (self.fake / "checks").write_text("none\n")
        m.update(ci="green", published=time.time() - 600)
        self.assertEqual(self.runner.checks(m)[0], "pending")    # green earlier: its run hasn't shown up yet

    def test_ci_repair_loop(self):
        (self.fake / "checks").write_text("fail\npass\n")
        self.write_tasks("- [ ] proj: Red then green\n")
        self.runner.run()
        m = self.store.rows()[0]
        self.assertEqual((m["status"], m["ci_repairs"]), ("ready", 1))
        builds = self.builds()
        self.assertEqual(len(builds), 2)
        self.assertNotIn("--resume", builds[0]["argv"])
        self.assertEqual(builds[1]["argv"][builds[1]["argv"].index("--resume") + 1], "sess-build")   # same session
        self.assertIn("FAILLOG: test_widget failed (run 77)", builds[1]["prompt"])
        self.assertEqual(len(self.gh_calls("pr create")), 1)        # one PR, pushed twice
        branch = (self.fake / "pr-1").read_text()
        self.assertEqual(git(self.proj, "rev-list", "--count", f"main..{branch}").strip(), "2")
        self.assertIn("pr: https://github.com/o/proj/pull/1\n  note: review PR", self.todo())

    def test_ci_cap(self):
        (self.fake / "checks").write_text("fail\n" * 5)
        self.write_tasks("- [ ] proj: Never green\n")
        self.runner.run()
        m = self.store.rows()[0]
        self.assertEqual((m["status"], m["stage"], m["ci_repairs"]), ("blocked", "ci", 3))
        self.assertEqual(len(self.builds()), 4)                  # first build + 3 CI repairs
        self.assertEqual(len(self.gh_calls("pr create")), 1)
        self.assertEqual(len(self.gh_calls("pr checks")), 4)
        todo = self.todo()
        self.assertRegex(todo, r"- \[!\] \S+ u3 i3 a2 proj: Never green\n  pr: https://github.com/o/proj/pull/1\n"
                               r"  note: CI red")
        task_id = todo.split("- [!] ")[1].split()[0]
        question = (self.me / "tasks" / f"{task_id}.md").read_text()
        self.assertIn("Towercab asks", question)
        self.assertIn("CI is still red", question)
        self.assertIn("FAILLOG", question)
        self.assertEqual(len(self.tg.texts), 1)
        self.assertIn("CI still red after 3 repairs", self.tg.texts[0])
        self.assertTrue(self.tg.texts[0].startswith("🔴 "))
        self.assertLessEqual(len(self.tg.texts[0].splitlines()), 4)              # shared template (PIP-16)
        self.assertIn("Never green", self.tg.texts[0])
        self.assertIn("https://github.com/o/proj/pull/1", self.tg.texts[0])

    # --- after review findings on the PR 21 + PR 20 merge -------------------
    def set_open(self, title):
        """What I do on my phone: turn a waiting task back to [ ] (drop its note)."""
        git(self.me, "pull", "-q")
        text = (self.me / "TODO.md").read_text()
        text = re.sub(r"  note: [^\n]*\n", "", text.replace("- [!] ", "- [ ] "))
        (self.me / "TODO.md").write_text(text)
        git(self.me, *GIT_ID, "commit", "-q", "-am", "retry")
        git(self.me, "push", "-q")

    def test_retry_continues_on_open_pr(self):
        (self.fake / "checks").write_text("fail\n" * 4)
        self.write_tasks("- [ ] proj: Never green\n")
        self.runner.run()
        branch = (self.fake / "pr-1").read_text()
        before = int(git(self.proj, "rev-list", "--count", f"main..{branch}"))
        self.set_open("Never green")
        (self.fake / "checks").write_text("pass\n")
        self.runner.run()
        second = [m for m in self.store.rows() if m["status"] == "ready"][0]
        self.assertEqual((second["head"], second["pr"]), (branch, "https://github.com/o/proj/pull/1"))
        self.assertEqual(len(self.gh_calls("pr create")), 1)                  # same PR, no second one
        self.assertGreaterEqual(int(git(self.proj, "rev-list", "--count", f"main..{branch}")), before)   # built on, not replaced
        self.assertIn("pr: https://github.com/o/proj/pull/1\n  note: review PR", self.todo())

    def test_fresh_attempt_replaces_stale_branch(self):
        (self.fake / "checks").write_text("fail\n" * 4)
        self.write_tasks("- [ ] proj: Never green\n")
        self.runner.run()
        (self.fake / "state").write_text("CLOSED")                             # I closed the PR
        self.set_open("Never green")
        (self.fake / "checks").write_text("pass\n")
        self.runner.run()
        self.assertEqual(len(self.gh_calls("pr create")), 2)                  # new PR on the same branch name
        self.assertIn("pr: https://github.com/o/proj/pull/2\n  note: review PR", self.todo())

    def test_blocked_pr_text_says_not_ready(self):
        (self.fake / "checks").write_text("fail\n" * 4)
        self.write_tasks("- [ ] proj: Never green\n")
        self.runner.run()
        edit = self.gh_calls("pr edit https://github.com/o/proj/pull/1")
        self.assertEqual(len(edit), 1)
        self.assertIn("⛔ Not ready: CI still red after 3 repairs", edit[0])

    def test_ready_without_pr_does_not_crash(self):
        self.write_tasks("- [ ] 261016-0000 proj: Old mission\n")
        mid = self.store.add("261016-0000 Old mission", "b", str(self.proj), ["true"], "claude", task="261016-0000",
                             repo="proj", branch="main")
        self.store.update(mid, status="ready")
        self.runner.settle()                                                   # no TypeError, no crash loop
        self.assertEqual(self.store.get(mid)["handled"], 1)
        self.assertEqual(self.gh_calls("pr edit"), [])
        self.assertIn("note: never published", self.todo())                    # not 'review PR'
        self.assertNotIn("Review: None", " ".join(self.tg.texts))

    def test_no_ci_pr_text_says_nothing_ran(self):
        (self.fake / "checks").write_text("none\n")
        self.write_tasks("- [ ] proj: Repo without CI\n")
        self.runner.run()
        self.assertEqual(self.store.rows()[0]["ci"], "none")
        edit = self.gh_edit_body()
        self.assertIn("- CI: no CI checks on this repo, nothing ran", edit)
        self.assertNotIn("passed", edit)

    def test_build_notes_keep_summary(self):
        (self.fake / "checks").write_text("fail\npass\n")
        self.write_tasks("- [ ] proj: Red then green\n")
        self.runner.run()
        notes = (Path(self.store.rows()[0]["workspace"]).parent / "build.txt").read_text()
        self.assertEqual(notes.count("Repair:"), 1)
        self.assertFalse(notes.startswith("Repair:"))                          # first build's summary leads

    def test_writer_failure_falls_back(self):
        (self.fake / "writer_fail").write_text("1")
        self.write_tasks("- [ ] proj: Ship it\n")
        self.runner.run()
        edit = self.gh_edit_body()
        self.assertIn("--body Ship it\n\n## What changed", edit)             # plain template, title as summary
        self.assertIn("note: review PR", self.todo())

    def push_my_fix(self, branch):
        """What I do by hand: push a fix to the PR's branch."""
        mine = self.root / "my-proj"
        if not mine.exists():
            subprocess.run(["git", "clone", "-q", str(self.proj), str(mine)], check=True)
        git(mine, "fetch", "-q", "origin")
        git(mine, "checkout", "-q", "-B", branch, f"origin/{branch}")
        (mine / "MY_FIX.txt").write_text("fixed by hand\n")
        git(mine, "add", ".")
        git(mine, *GIT_ID, "commit", "-q", "-m", "MY FIX")
        git(mine, "push", "-q", "origin", branch)
        return git(mine, "rev-parse", "HEAD").strip()

    def kept(self, branch, sha):
        return subprocess.run(["git", "-C", str(self.proj), "merge-base", "--is-ancestor", sha, branch]).returncode == 0

    def test_gh_failure_at_retry_asks_and_never_force_pushes(self):
        (self.fake / "checks").write_text("fail\n" * 4)
        self.write_tasks("- [ ] proj: Never green\n")
        self.runner.run()
        branch = (self.fake / "pr-1").read_text()
        fix = self.push_my_fix(branch)
        (self.fake / "view_fail").write_text("1")
        self.set_open("Never green")
        self.runner.run()
        self.assertTrue(self.kept(branch, fix))                                 # my fix survives
        self.assertEqual(len(self.gh_calls("pr create")), 1)
        self.assertIn("note: PR state unknown", self.todo())
        self.assertIn("pr: https://github.com/o/proj/pull/1", self.todo())

    def test_lost_pr_line_never_force_pushes(self):
        (self.fake / "checks").write_text("fail\n" * 4)
        self.write_tasks("- [ ] proj: Never green\n")
        self.runner.run()
        branch = (self.fake / "pr-1").read_text()
        fix = self.push_my_fix(branch)
        git(self.me, "pull", "-q")                                              # I delete the pr: line by hand
        (self.me / "TODO.md").write_text(re.sub(r"  (pr|note): [^\n]*\n", "", (self.me / "TODO.md").read_text()).replace("- [!] ", "- [ ] "))
        git(self.me, *GIT_ID, "commit", "-q", "-am", "lost pr")
        git(self.me, "push", "-q")
        (self.fake / "checks").write_text("pass\n")
        self.runner.run()
        self.assertTrue(self.kept(branch, fix))                                 # an open PR's branch is never forced
        self.assertIn("note: publish failed", self.todo())

    def test_retry_reviews_and_describes_the_whole_pr(self):
        (self.fake / "checks").write_text("fail\n" * 4)
        self.write_tasks("- [ ] proj: Never green\n")
        self.runner.run()
        branch = (self.fake / "pr-1").read_text()
        self.set_open("Never green")
        (self.fake / "checks").write_text("pass\n")
        self.runner.run()
        first, second = sorted(self.store.rows(), key=lambda m: m["created"])
        self.assertEqual(second["base"], git(self.proj, "merge-base", "main", branch).strip())   # whole PR, not the delta
        prompt = (self.fake / "writer.prompt").read_text()
        self.assertIn("Next attempt:", prompt)                                  # both attempts' notes
        edits = self.gh_edits()
        self.assertTrue(any("CI and review are running" in e for e in edits[1:-1]))   # stale text reset on the retry push
        self.assertIn("2 attempts", edits[-1])
        self.assertNotIn(": repair 0", git(self.proj, "log", "--format=%s", branch))

    def test_review_cap_says_review(self):
        (self.fake / "review_reject").write_text("1")
        self.write_tasks("- [ ] proj: Never good\n")
        self.runner.run()
        self.assertIn("note: blocked at review", self.todo())
        self.assertIn("⛔ Not ready: review rounds used up", self.gh_edits()[-1])

    def test_old_review_mission_gets_published(self):
        self.write_tasks("- [~] 261016-0000 proj: Queued at review before the upgrade\n")
        mid = self.store.add("261016-0000 Queued at review before the upgrade", "b", str(self.proj), ["true"], "claude",
                             task="261016-0000", repo="proj", branch="main")
        self.runner.factory.prepare(self.store.get(mid))
        self.store.update(mid, stage="review")
        self.runner.run(max_tasks=0)
        m = self.store.get(mid)
        self.assertEqual((m["status"], m["pr"]), ("ready", "https://github.com/o/proj/pull/1"))

    # --- Telegram commands (RUN-20..26) ---------------------------------------
    WAITING = "- [!] 261015-1000 proj: Talk first\n  note: review PR\n  pr: https://github.com/o/proj/pull/1\n"

    def test_approve(self):
        self.write_tasks(self.WAITING)
        self.tg.push_update(42, "approve 1000")
        self.runner.poll_telegram()
        self.assertEqual(self.tg.texts, ["approved 261015-1000 proj: Talk first"])
        todo = self.todo()
        self.assertIn("- [ ] 261015-1000 proj: Talk first\n  pr: https://github.com/o/proj/pull/1", todo)
        self.assertNotIn("note:", todo)

    def test_approve_errors(self):
        self.write_tasks(self.WAITING + "- [ ] 261015-1001 proj: Open\n- [!] 261016-1000 proj: Other\n")
        for text in ("approve 9999", "approve 1000", "approve 1001"):
            self.tg.push_update(42, text)
        before = self.todo()
        self.runner.poll_telegram()
        self.assertEqual(len(self.tg.texts), 3)
        self.assertIn("No single task", self.tg.texts[0])
        self.assertIn("No single task", self.tg.texts[1])        # 1000 matches two ids
        self.assertIn("isn't waiting", self.tg.texts[2])
        self.assertEqual(self.todo(), before)

    def test_other_chat_ignored(self):
        self.write_tasks(self.WAITING)
        self.tg.push_update(999, "approve 1000")
        self.runner.poll_telegram()
        self.assertEqual(self.tg.texts, [])
        self.assertIn("- [!] 261015-1000", self.todo())
        self.assertEqual(self.runner.offset, 101)                # consumed all the same

    def test_offset_advances_no_replay(self):
        self.write_tasks("- [ ] 261015-1000 proj: Open\n")
        self.tg.push_update(42, "next")
        self.runner.poll_telegram()
        self.runner.poll_telegram()
        self.assertEqual(len(self.tg.texts), 1)
        polls = [b for p, b in self.tg.calls if p.endswith("/getUpdates")]
        self.assertNotIn("offset", polls[0])
        self.assertEqual(polls[1]["offset"], 101)
        self.assertEqual(polls[1]["timeout"], 0)

    def test_status(self):
        self.write_tasks(self.WAITING + "- [ ] 261015-1001 proj: Open\n")
        self.tg.push_update(42, "/status@towercab_bot")
        self.runner.poll_telegram()
        text = self.tg.texts[0]
        self.assertIn("Running: nothing", text)
        self.assertIn("Waiting on you:\n- 261015-1000 proj: Talk first (review PR)", text)
        self.assertIn("Next: 261015-1001 proj: Open", text)

    def test_next(self):
        self.write_tasks("- [ ] 261015-1001 proj: Open\n")
        task, why = self.runner.next()
        self.tg.push_update(42, "next")
        self.runner.poll_telegram()
        self.assertEqual(self.tg.texts, [f"{task.label}\n  {why}"])

    def test_run(self):
        self.write_tasks(self.WAITING)
        self.tg.push_update(42, "run 1000")
        self.runner.poll_telegram()
        self.assertRegex(self.tg.texts[0], r"^261015-1000 proj: Talk first → mission ")
        self.assertEqual(len(self.store.rows()), 1)
        self.assertIn("- [~] 261015-1000", self.todo())

    def test_run_refused_while_busy(self):
        self.write_tasks(self.WAITING + "- [ ] 261015-1001 proj: Open\n")
        self.tg.push_update(42, "run 1000")
        self.tg.push_update(42, "run 1001")
        self.runner.poll_telegram()
        self.assertIn("already in flight", self.tg.texts[1])
        self.assertEqual(len(self.store.rows()), 1)

    def test_help(self):
        for text in ("dance", "approve", "run", ""):
            self.tg.push_update(42, text)
        self.runner.poll_telegram()
        self.assertEqual(len(self.tg.texts), 4)
        self.assertTrue(all(t.startswith("Commands:") for t in self.tg.texts))

    def test_updates_failure_is_quiet(self):
        logged = []
        self.tg.stop()
        notify = Notifier("tok", "42", self.tg.url, out=logged.append)
        self.assertEqual(notify.updates(), [])
        self.assertEqual(notify.updates(), [])
        self.assertEqual(len(logged), 1)
        self.assertNotIn("tok/", logged[0])
        self.tg = FakeTelegram()                                  # for tearDown

    def test_loop_runs_approve(self):
        self.write_tasks(self.WAITING)
        self.tg.push_update(42, "approve 1000")
        self.assertEqual(self.runner.run(max_tasks=0), 0)        # one pass: poll, nothing to start
        self.assertIn("- [ ] 261015-1000", self.todo())
        self.assertEqual(len(self.tg.texts), 1)

    def test_no_polling_without_telegram(self):
        self.runner.notify = Notifier(out=lambda *a: None)
        self.runner.poll_telegram()
        self.assertEqual(self.tg.calls, [])

    def test_slug(self):
        self.assertEqual(slug("Rename `factory` module → towercab!"), "rename-factory-module-towercab")


if __name__ == "__main__":
    unittest.main()
