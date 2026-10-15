"""End to end: the real loop, git and scheduler, with fake `claude` and `gh` executables."""
import json
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
stage = re.search(r"performing the (\w+) stage", prompt)[1]
limit = pathlib.Path(os.environ["FAKE_DIR"]) / "limit"
if limit.exists():
    limit.unlink()
    print(json.dumps({"type": "result", "is_error": True, "result": "You've hit your limit · resets 3pm (Europe/Berlin)"}))
    sys.exit(1)
denials, result = [], "ok"
if stage == "build":
    task = re.search(r"Task (\S+) in repo", prompt)[1]
    pathlib.Path(f"done-{task}.txt").write_text("done\n")
    if "LEAK" in prompt:
        denials = [{"tool_name": "Read", "tool_input": {"file_path": os.path.expanduser("~/.ssh/id_ed25519")}}]
if stage == "review":
    result = '{"approved": true, "feedback": "looks right"}'
print(json.dumps({"type": "result", "is_error": False, "result": result, "total_cost_usd": 0.01,
                  "duration_ms": 2000, "permission_denials": denials}))
'''

FAKE_GH = r'''#!PYTHON
import os, pathlib, sys
d = pathlib.Path(os.environ["FAKE_DIR"])
args = sys.argv[1:]
with (d / "gh.log").open("a") as f:
    f.write(" ".join(args) + "\n")
if args[:2] == ["pr", "create"]:
    n = len(list(d.glob("pr-*"))) + 1
    (d / f"pr-{n}").write_text(args[args.index("--head") + 1])
    print(f"https://github.com/o/proj/pull/{n}")
elif args[:2] == ["pr", "view"]:
    print((d / "state").read_text().strip() if (d / "state").exists() else "OPEN")
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
                             repos={"proj": RepoConfig("proj", self.proj_clone, verify, ["python3 *"])},
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
        self.assertRegex(done, r"proj: First thing · proj#1 · \$0\.03 · 0m06s · 1")
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
        self.assertEqual((m["status"], m["stage"], m["repairs"]), ("queued", "plan", 0))
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
        self.assertIn("note: blocked at plan", self.todo())

    def test_run_only_one_task(self):
        self.write_tasks("- [!] 261015-1000 proj: Talk first\n  note: talk first\n- [ ] proj: Normal one\n")
        self.assertEqual(self.runner.run(only="1000"), 1)
        todo = self.todo()
        self.assertIn("- [!] 261015-1000 u3 i3 a2 proj: Talk first\n  pr: https://github.com/o/proj/pull/1", todo)
        self.assertIn("- [ ] proj: Normal one", todo)              # not touched
        with self.assertRaises(ValueError):
            self.runner.run(only="9999")

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
