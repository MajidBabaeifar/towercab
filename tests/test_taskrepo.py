from pathlib import Path
import subprocess
import tempfile
import unittest

from towercab.taskrepo import SyncError, TaskRepo

GIT_ID = ["-c", "user.name=T", "-c", "user.email=t@localhost"]


def git(cwd, *args):
    return subprocess.run(["git", "-C", str(cwd), *args], check=True, text=True, capture_output=True).stdout


class TaskRepoTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.remote = root / "remote.git"
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(self.remote)], check=True)
        seed = root / "seed"
        subprocess.run(["git", "clone", "-q", str(self.remote), str(seed)], check=True, capture_output=True)
        (seed / "TODO.md").write_text("# TODO\n\n- [ ] r: first\n")
        git(seed, "add", ".")
        git(seed, *GIT_ID, "commit", "-q", "-m", "seed")
        git(seed, "push", "-q", "origin", "main")
        self.me = root / "me"  # my own clone, as on my laptop or phone
        subprocess.run(["git", "clone", "-q", str(self.remote), str(self.me)], check=True, capture_output=True)
        self.repo = TaskRepo(root / "towercab-clone", remote=str(self.remote))

    def tearDown(self):
        self.tmp.cleanup()

    def my_edit(self, line):
        git(self.me, "pull", "-q")
        with (self.me / "TODO.md").open("a") as f:
            f.write(line + "\n")
        git(self.me, *GIT_ID, "commit", "-q", "-am", "my edit")
        git(self.me, "push", "-q")

    def remote_todo(self):
        git(self.me, "pull", "-q")
        return (self.me / "TODO.md").read_text()

    def test_clones_and_reads(self):
        doc, done = self.repo.read()
        self.assertEqual([t.title for t in doc.list()], ["first"])
        self.assertEqual(done, "# DONE\n")

    def test_write_is_pushed(self):
        self.repo.mutate(lambda doc, f: doc.list()[0].mark("~"), "start")
        self.assertIn("- [~] r: first", self.remote_todo())

    def test_concurrent_edits_both_kept(self):
        self.repo.read()
        calls = []

        def change(doc, files):
            calls.append(1)
            if len(calls) == 1:          # I push while Towercab is mid-write
                self.my_edit("- [ ] r: added from my phone")
            doc.list()[0].mark("~")
            files["DONE.md"] += "2026-10-15 x r: y\n"

        self.repo.mutate(change, "start")
        todo = self.remote_todo()
        self.assertEqual(len(calls), 2)
        self.assertIn("- [~] r: first", todo)
        self.assertIn("- [ ] r: added from my phone", todo)
        self.assertIn("2026-10-15 x r: y", (self.me / "DONE.md").read_text())

    def test_no_change_no_commit(self):
        self.repo.read()
        head = git(self.repo.path, "rev-parse", "HEAD")
        self.assertEqual(self.repo.mutate(lambda doc, f: "nothing", "noop"), "nothing")
        self.assertEqual(git(self.repo.path, "rev-parse", "HEAD"), head)

    def test_dirty_clone_is_refused(self):
        self.repo.read()
        (self.repo.path / "TODO.md").write_text("local edit\n")
        with self.assertRaises(SyncError):
            self.repo.read()

    def test_task_files(self):
        self.repo.mutate(lambda doc, f: f.__setitem__("tasks/1.md", "question\n"), "ask")
        self.assertEqual(self.repo.task_note("1"), "question\n")
        self.assertEqual(self.repo.task_note("2"), "")


if __name__ == "__main__":
    unittest.main()
