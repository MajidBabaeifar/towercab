"""Work down the Gradient Tasks list: pick, delegate, watch, finish, repeat (RUN-1..9)."""
from __future__ import annotations

from datetime import datetime
import json
from pathlib import Path
import re
import shutil
import subprocess
import time

from .core import MAX_CI_REPAIRS, Factory, command, mission_usage
from .notify import Notifier
from .tasks import done_line, pick_next
from .writer import write_body

GITHUB_RE = re.compile(r"github\.com[:/](?P<repo>[^/]+/[^/]+?)(?:\.git)?/?$")
PR_RE = re.compile(r"github\.com/[^/]+/(?P<name>[^/]+)/pull/(?P<n>\d+)")


def slug(title, limit=40):
    words = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return words[:limit].rstrip("-") or "task"


def short_pr(url):
    m = PR_RE.search(url or "")
    return f"{m['name']}#{m['n']}" if m else (url or "")


def started(check):
    """A check's start as epoch seconds; None if unknown."""
    try:
        return datetime.fromisoformat(check["startedAt"].replace("Z", "+00:00")).timestamp()
    except (KeyError, AttributeError, TypeError, ValueError):
        return None


def find(doc, ref):
    """Locate a task again after a fresh read: by ID, else by repo + title."""
    for t in doc.list():
        if (ref.get("id") and t.id == ref["id"]) or (not ref.get("id") and t.repo == ref["repo"] and t.title == ref["title"]):
            return t
    return None


class Runner:
    def __init__(self, store, config, tasks, gh="gh", out=print, pr_interval=60, notify=None, writer=write_body):
        self.s, self.c, self.tasks, self.gh, self.out = store, config, tasks, gh, out
        self.writer = writer
        self.notify = notify or Notifier.from_config(config, out)
        self.factory = Factory(store, config.timeout, self.notify, publisher=self)
        self.pr_interval = pr_interval
        self._last_pr_check = 0.0
        self.offset = None   # next Telegram update_id to fetch

    # --- choosing ----------------------------------------------------------
    def next(self):
        doc, done = self.tasks.read()
        return pick_next(doc, done, self.c.cutoff)

    def ask(self, ref, question, note=None, pr=None):
        """Mark a task waiting on me and put the question in tasks/<id>.md (RUN-3, RUN-5)."""
        stamp = time.strftime("%Y-%m-%d %H:%M")

        def change(doc, files):
            t = find(doc, ref)
            if not t:
                return None
            doc.normalize(t)
            t.mark("!")
            if pr:
                t.set("pr", pr)
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
            return t.id, t.title, t.get("done when"), t.model, t.get("pr")
        claimed = self.tasks.mutate(claim, f"Towercab: start {task.id or task.title}")
        if not claimed:
            return None
        task_id, title, done_when, model, task_pr = claimed
        pr, head = self.open_pr(task_pr)
        note = self.tasks.task_note(task_id)
        brief = (f"Task {task_id} in repo {repo.name}: {title}\n"
                 f"Done when: {done_when or 'the title is fully true and checks pass'}\n")
        if head:
            brief += (f"\nThis is a retry: you start on the branch of its open PR ({pr}), with the earlier "
                      "attempt's commits and any fixes pushed there. Continue from them.\n")
        if note:
            brief += f"\nNotes, plans and answers (tasks/{task_id}.md):\n{note}\n"
        remote = repo.remote or command(["git", "remote", "get-url", "origin"], repo.path)
        mid = self.s.add(f"{task_id} {title}", brief, remote, repo.verify, self.c.provider, self.c.reviewer,
                         max_repairs=self.c.max_repairs, task=task_id, repo=repo.name, branch=repo.base,
                         model=model or self.c.model, bash=repo.bash, pr=pr, head=head)
        self.out(f"{task_id} → mission {mid}" + (f" (continues {short_pr(pr)})" if pr else ""))
        return mid

    def open_pr(self, url):
        """(url, head branch) if the task's PR is still open, else (None, None): a retry continues there."""
        if not url:
            return None, None
        try:
            r = subprocess.run([self.gh, "pr", "view", url, "--json", "state,headRefName"],
                               capture_output=True, text=True)
            info = json.loads(r.stdout) if r.returncode == 0 else {}
        except (OSError, ValueError):
            info = {}
        if info.get("state") == "OPEN" and info.get("headRefName"):
            return url, info["headRefName"]
        return None, None

    # --- publishing and CI (PIP-2, PIP-3) --------------------------------------
    @property
    def ci_poll(self):
        return self.c.ci_poll

    def gh_repo(self, m):
        found = GITHUB_RE.search(m["remote"] or "")
        return ["--repo", found["repo"]] if found else []

    def publish(self, m):
        """Commit the build, push `towercab/<id>-<slug>`, open the PR the first time (PIP-2, RUN-8).
        Returns the PR URL."""
        work = Path(m["workspace"])
        branch = m.get("head") or f"towercab/{m['task']}-{slug(m['title'].split(' ', 1)[-1])}"
        title = m["title"].split(" ", 1)[-1]
        command(["git", "add", "-A"], work)
        if subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=work).returncode:
            ident = []
            if not subprocess.run(["git", "config", "user.email"], cwd=work, capture_output=True, text=True).stdout.strip():
                ident = ["-c", "user.name=Towercab", "-c", "user.email=towercab@localhost"]
            subject = title if not m["pr"] else f"{title}: repair {m['repairs'] + m['ci_repairs']}"
            command(["git", *ident, "commit", "-q", "-m", f"{subject}\n\nTask {m['task']}, Towercab mission {m['id']}."], work)
        # A fresh attempt may meet a branch left by an earlier one whose PR is closed: Towercab owns
        # towercab/* branches, so its first push replaces it. Later pushes never force, so a fix I
        # push to the branch meanwhile makes the push fail instead of being overwritten.
        force = ["--force"] if not m["pr"] and not m.get("head") else []
        command(["git", "push", "-q", *force, m["remote"], f"HEAD:refs/heads/{branch}"], work)
        if m["pr"]:
            return m["pr"]
        body = (f"{title}\n\nCI and review are running; Towercab replaces this text once the PR is ready.\n\n"
                f"<sub>🤖 Built by Towercab · task `{m['task']}` · mission `{m['id']}`</sub>")
        argv = [self.gh, "pr", "create", "--base", m["branch"] or "main", "--head", branch, "--title", title,
                "--body", body, *self.gh_repo(m)]
        return subprocess.run(argv, cwd=work, capture_output=True, text=True, check=True).stdout.strip().splitlines()[-1]

    def set_body(self, m, body):
        """Replace the PR text; a failure is logged, never raised (PIP-14)."""
        try:
            r = subprocess.run([self.gh, "pr", "edit", m["pr"], "--body", body, *self.gh_repo(m)],
                               capture_output=True, text=True)
            err = (r.stderr or r.stdout).strip() if r.returncode else ""
        except OSError as exc:
            err = str(exc)
        if err:
            self.s.event(m["id"], f"PR text not updated: {err[:300]}")

    def describe(self, m):
        """Final PR text once CI is green and review approved: Haiku from the builder's notes and the
        review, plain template if it can't (PIP-11, PIP-14, PIP-15). Never blocks the task."""
        if not m.get("pr"):
            return
        try:
            work = Path(m["workspace"])
            notes = {n: (work.parent / f"{n}.txt").read_text() if (work.parent / f"{n}.txt").exists() else ""
                     for n in ("build", "review")}
            cost, seconds = mission_usage(work.parent)
            usage = f"${cost:.2f} API-equivalent · {seconds / 60:.1f} min agent time" if cost is not None else "usage unknown"
            ci = "no CI checks on this repo, nothing ran" if m.get("ci") == "none" else "green"
            counted = dict(m, repairs=(m["repairs"] or 0) + (m.get("ci_repairs") or 0))
            body = self.writer(shutil.which("claude") or "claude", counted, m["title"].split(" ", 1)[-1],
                               notes["build"], notes["review"], " ".join(json.loads(m["verify"])), usage, ci=ci)
        except Exception as exc:   # the PR text must never cost the task
            self.s.event(m["id"], f"PR text not written: {exc}"[:300])
            return
        self.set_body(m, body)

    def stopped(self, m, why):
        """A blocked mission's PR must not keep promising that CI and review are running."""
        if m.get("pr"):
            self.set_body(m, f"⛔ Not ready: {why}. Towercab asked in `tasks/{m['task']}.md`; "
                             f"the task waits for an answer.\n\n"
                             f"<sub>🤖 Built by Towercab · task `{m['task']}` · mission `{m['id']}`</sub>")

    def checks(self, m):
        """The PR's CI: ("pending" | "pass" | "fail", text); text is failing logs on fail (PIP-3)."""
        r = subprocess.run([self.gh, "pr", "checks", m["pr"], "--json", "name,bucket,link,startedAt", *self.gh_repo(m)],
                           capture_output=True, text=True)
        try:
            found = json.loads(r.stdout or "null")
        except ValueError:
            found = None
        if not isinstance(found, list):
            if "no checks" not in (r.stderr + r.stdout).lower():
                raise ValueError(f"gh pr checks exited {r.returncode}: {(r.stderr or r.stdout).strip()[:500]}")
            found = []
        published = m["published"] or 0
        if time.time() - published < self.c.ci_grace:
            # Right after a push the PR may still show the previous commit's checks, or none yet.
            found = [c for c in found if started(c) is None or started(c) >= published - 5]
            if not found:
                return "pending", ""
        if not found:
            return "pass", "No CI checks on this PR."
        buckets = {c.get("bucket") for c in found}
        summary = "\n".join(f"{c.get('bucket')}: {c.get('name')} {c.get('link') or ''}".rstrip() for c in found)
        if "pending" in buckets:
            return "pending", summary
        failed = [c for c in found if c.get("bucket") in ("fail", "cancel")]
        if not failed:
            return "pass", summary
        logs, runs = [], []
        for c in failed:
            run = re.search(r"/actions/runs/(\d+)", c.get("link") or "")
            if run and run[1] not in runs:
                runs.append(run[1])
                out = subprocess.run([self.gh, "run", "view", run[1], "--log-failed", *self.gh_repo(m)],
                                     capture_output=True, text=True)
                logs.append(out.stdout.strip() or out.stderr.strip())
        return "fail", (summary + "\n\n" + "\n\n".join(logs))[-16000:]

    # --- finishing -----------------------------------------------------------
    def settle(self):
        """React to missions that ended: review marker, or a question (RUN-5, RUN-8, PIP-3)."""
        for m in self.s.rows():
            if not m["task"] or m["handled"] or m["status"] not in ("ready", "blocked"):
                continue
            ref = {"id": m["task"]}
            if m["status"] == "ready":
                url = m["pr"]
                self.describe(m)

                def mark(doc, files):
                    t = find(doc, ref)
                    if t:
                        t.mark("!")
                        t.set("pr", url)
                        t.set("note", "review PR")
                self.tasks.mutate(mark, f"Towercab: {m['task']} ready, {short_pr(url)}")
                self.s.event(m["id"], f"Ready for review: {url}")
                self.out(f"{m['task']} → {url}")
                self.notify.pr_ready(m["title"], url)
            elif m["stage"] == "publish":
                err = m["feedback"].strip()
                self.ask(ref, f"Mission {m['id']} was built but publishing failed:\n\n{err[:1500]}\n\n"
                              f"Workspace: {m['workspace']}", note="publish failed", pr=m["pr"])
                self.notify.asking(m["title"], f"Publishing failed:\n{err[-300:]}")
                self.stopped(m, "publishing a repair failed")
            elif m["stage"] == "ci" and m["ci_repairs"] >= MAX_CI_REPAIRS:
                self.ask(ref, f"CI is still red on {m['pr']} after {m['ci_repairs']} repairs (mission {m['id']}). "
                              f"Last failing output:\n\n```\n{m['feedback'].strip()[-1500:]}\n```\n\n"
                              "What's wrong? Fix it on the branch or answer here, then set the task back to `[ ]`.",
                         note="CI red", pr=m["pr"])
                self.out(f"{m['task']} CI red after {m['ci_repairs']} repairs; asked you")
                self.notify.ci_gave_up(m["title"], m["pr"], m["ci_repairs"], m["feedback"])
                self.stopped(m, f"CI still red after {m['ci_repairs']} repairs")
            else:
                self.ask(ref, f"Mission {m['id']} stopped at the {m['stage']} stage:\n\n{m['feedback'].strip()[-1500:]}\n\n"
                              "Answer here if it helps, then set the task back to `[ ]` to run it again.",
                         note=f"blocked at {m['stage']}", pr=m["pr"])
                self.out(f"{m['task']} blocked at {m['stage']}; asked you")
                self.notify.stuck(m["title"], m["stage"], m["feedback"])
                self.stopped(m, f"stopped at the {m['stage']} stage")
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
                    waits = [m["wait"] for m in self.active() if m["status"] == "queued" and m["wait"]]
                    if watch or waits:   # a pending CI is part of the task: wait for it (PIP-3)
                        time.sleep(poll if not waits else max(0.0, min(poll, min(waits) - time.time())))
                        continue
                    break
            except KeyboardInterrupt:
                self.settle()
                self.out("Stopped. Running task marked waiting on you; set it to [ ] to retry.")
                raise
            self.settle()
        return started

