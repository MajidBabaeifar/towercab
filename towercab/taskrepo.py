"""The gradient-tasks git repo: pull before every read, push every write, never drop an edit (TSK-5)."""
from __future__ import annotations

from pathlib import Path
import subprocess

from .tasks import Document

IDENTITY = ["-c", "user.name=Towercab", "-c", "user.email=towercab@localhost"]


class SyncError(RuntimeError):
    pass


class TaskRepo:
    def __init__(self, path, remote=None):
        self.path = Path(path).expanduser()
        self.remote = remote

    def git(self, *args, check=True):
        r = subprocess.run(["git", "-C", str(self.path), *args], text=True, capture_output=True)
        if check and r.returncode:
            raise SyncError(f"git {' '.join(args)}: {r.stderr.strip() or r.stdout.strip()}")
        return r

    def ensure(self):
        if not (self.path / ".git").exists():
            if not self.remote:
                raise SyncError(f"{self.path} is not a git repo and no tasks.remote is configured")
            self.path.parent.mkdir(parents=True, exist_ok=True)
            r = subprocess.run(["git", "clone", "-q", self.remote, str(self.path)], text=True, capture_output=True)
            if r.returncode:
                raise SyncError(f"clone {self.remote}: {r.stderr.strip()}")
        if self.git("status", "--porcelain").stdout.strip():
            raise SyncError(f"{self.path} has uncommitted changes; Towercab only works on a clean task repo")

    def has_upstream(self):
        return self.git("rev-parse", "--abbrev-ref", "@{u}", check=False).returncode == 0

    def pull(self):
        self.ensure()
        if self.has_upstream() and self.git("pull", "-q", "--rebase", check=False).returncode:
            self.git("rebase", "--abort", check=False)
            raise SyncError("pull --rebase failed in the task repo; resolve it by hand")

    def files(self):
        todo, done = self.path / "TODO.md", self.path / "DONE.md"
        return (todo.read_text() if todo.exists() else "# TODO\n",
                done.read_text() if done.exists() else "# DONE\n")

    def read(self):
        """Fresh (Document, DONE.md text)."""
        self.pull()
        todo, done = self.files()
        return Document(todo), done

    def task_note(self, task_id):
        f = self.path / "tasks" / f"{task_id}.md"
        return f.read_text() if f.exists() else ""

    def mutate(self, change, message, retries=5):
        """Apply change(doc, files) to the latest list and push it.

        change gets the fresh Document and a dict of extra files {relative path: text}
        (DONE.md is preloaded). It returns a value, or False/None changes nothing.
        On a rejected push Towercab drops its own commit, pulls, and re-applies the change
        to the new content, so edits pushed meanwhile are never overwritten.
        """
        for _ in range(retries):
            doc, done = self.read()
            before = doc.render()
            files = {"DONE.md": done}
            result = change(doc, files)
            changed = {"TODO.md": doc.render()} if doc.render() != before else {}
            for rel, text in files.items():
                path = self.path / rel
                old = path.read_text() if path.exists() else None
                if text != old and not (rel == "DONE.md" and old is None and text == done):
                    changed[rel] = text
            if not changed:
                return result
            for rel, text in changed.items():
                path = self.path / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text)
            self.git("add", "--", *changed)
            self.git(*IDENTITY, "commit", "-q", "-m", message)
            if not self.has_upstream() or self.git("push", "-q", check=False).returncode == 0:
                return result
            self.git("reset", "-q", "--hard", "HEAD~1")
        raise SyncError(f"could not push '{message}' after {retries} tries")
