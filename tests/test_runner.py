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
from towercab.runner import Runner, slug
from towercab.taskrepo import TaskRepo

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
        self.runner = Runner(self.store, self.config, TaskRepo(self.config.tasks_path, self.config.tasks_remote),
                             gh=str(self.gh), out=lambda *a: None)

    def tearDown(self):
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

    def test_slug(self):
        self.assertEqual(slug("Rename `factory` module → towercab!"), "rename-factory-module-towercab")


if __name__ == "__main__":
    unittest.main()
