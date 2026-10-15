"""Work down the Gradient Tasks list: pick, delegate, watch, finish, repeat (RUN-1..9)."""
from __future__ import annotations

import json
from pathlib import Path
import re
import subprocess
import time

from .core import Factory, command, mission_usage
from .notify import Notifier
from .tasks import done_line, pick_next

GITHUB_RE = re.compile(r"github\.com[:/](?P<repo>[^/]+/[^/]+?)(?:\.git)?/?$")
PR_RE = re.compile(r"github\.com/[^/]+/(?P<name>[^/]+)/pull/(?P<n>\d+)")


def slug(title, limit=40):
    words = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return words[:limit].rstrip("-") or "task"


def short_pr(url):
    m = PR_RE.search(url or "")
    return f"{m['name']}#{m['n']}" if m else (url or "")


def find(doc, ref):
    """Locate a task again after a fresh read: by ID, else by repo + title."""
    for t in doc.list():
        if (ref.get("id") and t.id == ref["id"]) or (not ref.get("id") and t.repo == ref["repo"] and t.title == ref["title"]):
            return t
    return None


class Runner:
    def __init__(self, store, config, tasks, gh="gh", out=print, pr_interval=60, notify=None):
        self.s, self.c, self.tasks, self.gh, self.out = store, config, tasks, gh, out
        self.notify = notify or Notifier.from_config(config, out)
        self.factory = Factory(store, config.timeout, self.notify)
        self.pr_interval = pr_interval
        self._last_pr_check = 0.0
        self.offset = None   # next Telegram update_id to fetch

    # --- choosing ----------------------------------------------------------
    def next(self):
        doc, done = self.tasks.read()
        return pick_next(doc, done, self.c.cutoff)

    def ask(self, ref, question, note=None):
        """Mark a task waiting on me and put the question in tasks/<id>.md (RUN-3, RUN-5)."""
        stamp = time.strftime("%Y-%m-%d %H:%M")

        def change(doc, files):
            t = find(doc, ref)
            if not t:
                return None
            doc.normalize(t)
            t.mark("!")
            if note:
                t.set("note", note)
            path = f"tasks/{t.id}.md"
            old = files.get(path) or self.tasks.task_note(t.id) or f"# {t.id} {t.repo}: {t.title}\n"
            files[path] = old.rstrip("\n") + f"\n\n## {stamp} Towercab asks\n\n{question.strip()}\n"
            return t.id
        return self.tasks.mutate(change, f"Towercab: question on {ref.get('id') or ref['title']}")

    def start(self, task, force=False):
        """Hand a task to an agent as a mission (RUN-5). Returns the mission id, or None if it had to ask.
        force: operator override, also starts a task that waits on me (RUN-11)."""
        ref = {"id": task.id, "repo": task.repo, "title": task.title}
        repo = self.c.repo(task.repo)
        if repo is None:
            self.ask(ref, f"Repo `{task.repo}` isn't in {self.c.source}. Add a `[repos.{task.repo}]` "
                          "section (path, verify, bash), then set this task back to `[ ]`.", note="unknown repo")
            self.out(f"{task.label}: unknown repo, asked you")
            self.notify.asking(task.label, f"Unknown repo `{task.repo}`: add it to {self.c.source}.")
            return None

        def claim(doc, files):
            t = find(doc, ref)
            if not t or (t.state != "open" and not (force and t.state == "waiting")):
                return None
            doc.normalize(t)
            t.mark("~")
            t.set("note", None)
            return t.id, t.title, t.get("done when"), t.model
        claimed = self.tasks.mutate(claim, f"Towercab: start {task.id or task.title}")
        if not claimed:
            return None
        task_id, title, done_when, model = claimed
        note = self.tasks.task_note(task_id)
        brief = (f"Task {task_id} in repo {repo.name}: {title}\n"
                 f"Done when: {done_when or 'the title is fully true and checks pass'}\n")
        if note:
            brief += f"\nNotes, plans and answers (tasks/{task_id}.md):\n{note}\n"
        remote = repo.remote or command(["git", "remote", "get-url", "origin"], repo.path)
        mid = self.s.add(f"{task_id} {title}", brief, remote, repo.verify, self.c.provider, self.c.reviewer,
                         max_repairs=self.c.max_repairs, task=task_id, repo=repo.name, branch=repo.base,
                         model=model or self.c.model, bash=repo.bash)
        self.out(f"{task_id} → mission {mid}")
        return mid

    # --- finishing -----------------------------------------------------------
    def finish(self, m):
        """Commit the mission's work, push a branch and open a PR (RUN-8). Returns the PR URL."""
        work = Path(m["workspace"])
        branch = f"towercab/{m['task']}-{slug(m['title'].split(' ', 1)[-1])}"
        command(["git", "add", "-A"], work)
        ident = []
        if not subprocess.run(["git", "config", "user.email"], cwd=work, capture_output=True, text=True).stdout.strip():
            ident = ["-c", "user.name=Towercab", "-c", "user.email=towercab@localhost"]
        title = m["title"].split(" ", 1)[-1]
        command(["git", *ident, "commit", "-q", "-m", f"{title}\n\nTask {m['task']}, Towercab mission {m['id']}."], work)
        command(["git", "push", "-q", m["remote"], f"HEAD:refs/heads/{branch}"], work)
        cost, seconds = mission_usage(work.parent)
        review = (work.parent / "review.txt").read_text() if (work.parent / "review.txt").exists() else ""
        usage = f"${cost:.2f} API-equivalent · {seconds / 60:.1f} min agent time" if cost is not None else "usage unknown"
        body = (f"Task `{m['task']}` · mission `{m['id']}` · {m['repairs']} repairs · {usage}\n\n"
                f"Review: {review.strip()[:1500]}\n\nTest:\n- [x] verify: `{' '.join(json.loads(m['verify']))}`\n"
                f"- [x] reviewer agent approved\n\n🤖 Built by Towercab")
        argv = [self.gh, "pr", "create", "--base", m["branch"] or "main", "--head", branch, "--title", title, "--body", body]
        gh_repo = GITHUB_RE.search(m["remote"] or "")
        if gh_repo:
            argv += ["--repo", gh_repo["repo"]]
        url = subprocess.run(argv, cwd=work, capture_output=True, text=True, check=True).stdout.strip().splitlines()[-1]
        return url

    def settle(self):
        """React to missions that ended: PR + review marker, or a question (RUN-5, RUN-8)."""
        for m in self.s.rows():
            if not m["task"] or m["handled"] or m["status"] not in ("ready", "blocked"):
                continue
            ref = {"id": m["task"]}
            if m["status"] == "ready":
                try:
                    url = self.finish(m)
                except (subprocess.CalledProcessError, OSError) as exc:
                    err = getattr(exc, "stderr", "") or str(exc)
                    self.ask(ref, f"Mission {m['id']} passed review but publishing failed:\n\n{err.strip()[:1500]}\n\n"
                                  f"Workspace: {m['workspace']}")
                    self.notify.asking(m["title"], f"Publishing failed:\n{err.strip()[-300:]}")
                else:
                    def mark(doc, files):
                        t = find(doc, ref)
                        if t:
                            t.mark("!")
                            t.set("pr", url)
                            t.set("note", "review PR")
                    self.tasks.mutate(mark, f"Towercab: {m['task']} ready, {short_pr(url)}")
                    self.s.event(m["id"], f"PR opened: {url}")
                    self.out(f"{m['task']} → {url}")
                    self.notify.pr_ready(m["title"], url)
            else:
                self.ask(ref, f"Mission {m['id']} stopped at the {m['stage']} stage:\n\n{m['feedback'].strip()[-1500:]}\n\n"
                              "Answer here if it helps, then set the task back to `[ ]` to run it again.",
                         note=f"blocked at {m['stage']}")
                self.out(f"{m['task']} blocked at {m['stage']}; asked you")
                self.notify.stuck(m["title"], m["stage"], m["feedback"])
            self.s.update(m["id"], handled=1)

    def check_prs(self, force=False):
        """Merged PRs move their task to DONE.md with cost, time, attempts (RUN-8, TSK-6)."""
        if not force and time.time() - self._last_pr_check < self.pr_interval:
            return
        self._last_pr_check = time.time()
        doc, _ = self.tasks.read()
        for t in doc.list():
            url = t.get("pr")
            if t.state != "waiting" or not url:
                continue
            r = subprocess.run([self.gh, "pr", "view", url, "--json", "state", "--jq", ".state"],
                               capture_output=True, text=True)
            state = r.stdout.strip()
            if state == "MERGED":
                missions = [m for m in self.s.rows() if m["task"] == t.id]
                cost = seconds = 0.0
                known = False
                for m in missions:
                    if m["workspace"]:
                        c, sec = mission_usage(Path(m["workspace"]).parent)
                        if c is not None:
                            known, cost, seconds = True, cost + c, seconds + sec
                ref = {"id": t.id}

                def done(doc, files, url=url, missions=missions, known=known, cost=cost, seconds=seconds):
                    task = find(doc, ref)
                    if not task:
                        return
                    doc.remove(task)
                    line = done_line(task, short_pr(url), cost if known else None, seconds if known else None,
                                     len(missions) or None)
                    files["DONE.md"] = files["DONE.md"].rstrip("\n") + "\n" + line + "\n"
                self.tasks.mutate(done, f"Towercab: {t.id} merged")
                self.out(f"{t.id} merged → DONE.md")
                self.notify.merged(t.label, short_pr(url))
            elif state == "CLOSED" and t.get("note") != "PR closed without merge":
                ref = {"id": t.id}
                self.tasks.mutate(lambda doc, files: find(doc, ref) and find(doc, ref).set("note", "PR closed without merge"),
                                  f"Towercab: {t.id} PR closed")

    # --- commands from my phone (RUN-20..26) ---------------------------------
    def poll_telegram(self):
        """Fetch new messages once, answer commands from my chat, ignore everything else."""
        if not self.notify.enabled:
            return
        from .commands import Commands
        for update_id, chat_id, text in self.notify.updates(self.offset):
            self.offset = update_id + 1    # consumed, ignored or not
            if chat_id != str(self.notify.chat_id):
                continue
            self.notify.send(Commands(self).handle(text))

    # --- the loop -----------------------------------------------------------
    def active(self):
        return [m for m in self.s.rows() if m["task"] and m["status"] in ("queued", "running")]

    def run_one(self, ref):
        """Operator command: run exactly this task now, whatever its priority or marker (RUN-11)."""
        doc, _ = self.tasks.read()
        try:
            task = doc.get(ref)
        except KeyError:
            raise ValueError(f"No single task matches {ref!r}") from None
        if task.state == "running" or self.active():
            raise ValueError("A task is already in flight; let it finish or stop it first")
        return task

    def run(self, watch=False, max_tasks=None, poll=5, only=None):
        """Take the next task whenever nothing is in flight; stop cleanly on Ctrl-C (RUN-9).
        only: run just this task (ID or unique suffix), then stop (RUN-11)."""
        started, refused = 0, None
        with self.s.lock():
            self.factory.recover()
            if only:
                task = self.run_one(only)
                self.out(f"only: {task.label}")
                if not self.start(task, force=True):
                    return 0
                started, max_tasks, watch = 1, 1, False
            try:
                while True:
                    self.settle()
                    self.check_prs()
                    self.poll_telegram()
                    if not self.active() and (max_tasks is None or started < max_tasks):
                        task, why = self.next()
                        if task and task.label != refused:
                            self.out(f"next: {task.label} ({why})")
                            if self.start(task):
                                started += 1
                            else:
                                refused = task.label  # never spin on a task that can't start
                            continue
                    eligible = self.factory.eligible()
                    if eligible:
                        self.factory.step(eligible[0])
                        continue
                    if watch:
                        time.sleep(poll)
                        continue
                    break
            except KeyboardInterrupt:
                self.settle()
                self.out("Stopped. Running task marked waiting on you; set it to [ ] to retry.")
                raise
            self.settle()
        return started

