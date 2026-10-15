"""Gradient Tasks format: parse and write TODO.md / DONE.md without losing a byte."""
from __future__ import annotations

from dataclasses import dataclass, field
import re
import time

DEFAULTS = {"u": 3, "i": 3, "a": 2}
MARKERS = {" ": "open", "~": "running", "!": "waiting", "x": "done"}

TASK_RE = re.compile(r"^- \[(?P<m>[ ~!xX])\] (?P<rest>.+)$")
CONT_RE = re.compile(r"^  (?P<key>[a-z][a-z ]*): (?P<value>.*)$")
ID_RE = re.compile(r"^\d{6}-\d{4}(?:-\d+)?$")
SCORE_RE = re.compile(r"^([uia])([1-5])$")
REPO_RE = re.compile(r"^([a-z0-9][a-z0-9._-]*):$")
AFTER_RE = re.compile(r"^after:(\S+)$")
MODEL_RE = re.compile(r"^@([\w.-]+)$")


class ParseError(ValueError):
    pass


@dataclass
class Task:
    marker: str
    repo: str
    title: str
    id: str | None = None
    scores: dict = field(default_factory=dict)  # only scores written in the file
    after: list = field(default_factory=list)
    model: str | None = None
    fields: list = field(default_factory=list)  # [(key, value)] continuation lines, in order
    raw: list | None = None  # original lines; None once changed
    position: int = 0

    # --- derived -------------------------------------------------------
    @property
    def state(self):
        return MARKERS[self.marker.lower()]

    def score(self, name):
        return self.scores.get(name, DEFAULTS[name])

    @property
    def priority(self):
        return 2 * self.score("i") + self.score("u")

    def get(self, key):
        return next((v for k, v in self.fields if k == key), None)

    def set(self, key, value):
        """Set or (value None) remove a continuation field."""
        rest = [(k, v) for k, v in self.fields if k != key]
        if value is not None:
            rest.append((key, value))
        self.fields = rest
        self.raw = None

    def mark(self, marker):
        self.marker = marker
        self.raw = None

    @property
    def label(self):
        return f"{self.id or '(no id)'} {self.repo}: {self.title}"

    # --- writing ---------------------------------------------------------
    def render(self):
        if self.raw is not None:
            return list(self.raw)
        head = [f"- [{self.marker}]"]
        if self.id:
            head.append(self.id)
        head += [f"{k}{self.scores[k]}" for k in "uia" if k in self.scores]
        head.append(f"{self.repo}: {self.title}")
        head += [f"after:{a}" for a in self.after]
        if self.model:
            head.append(f"@{self.model}")
        return [" ".join(head)] + [f"  {k}: {v}" for k, v in self.fields]


def parse_task_line(line):
    m = TASK_RE.match(line)
    if not m:
        raise ParseError(f"not a task line: {line!r}")
    tokens = m["rest"].split(" ")
    task_id, scores = None, {}
    if tokens and ID_RE.match(tokens[0]):
        task_id = tokens.pop(0)
    while tokens and SCORE_RE.match(tokens[0]):
        name, value = SCORE_RE.match(tokens.pop(0)).groups()
        if name in scores:
            raise ParseError(f"score {name} given twice: {line!r}")
        scores[name] = int(value)
    if not tokens or not REPO_RE.match(tokens[0]):
        raise ParseError(f"expected '<repo>:' after marker, id and scores: {line!r}")
    repo = REPO_RE.match(tokens.pop(0))[1]
    after, model = [], None
    while tokens:
        if AFTER_RE.match(tokens[-1]):
            after = [a for a in AFTER_RE.match(tokens.pop())[1].split(",") if a] + after
        elif MODEL_RE.match(tokens[-1]) and model is None:
            model = MODEL_RE.match(tokens.pop())[1]
        else:
            break
    title = " ".join(tokens).strip()
    if not title:
        raise ParseError(f"task has no title: {line!r}")
    bad = [a for a in after if not ID_RE.match(a)]
    if bad:
        raise ParseError(f"after: needs task IDs, got {bad}: {line!r}")
    return Task(m["m"], repo, title, task_id, scores, after, model)


class Document:
    """A TODO.md: task entries plus every other line kept verbatim."""

    def __init__(self, text=""):
        self.entries = []  # str (raw line) or Task
        self.errors = []   # (line number, message)
        self.trailing_newline = text.endswith("\n")
        lines = text.split("\n")
        if self.trailing_newline:
            lines.pop()
        current = None
        for n, line in enumerate(lines, 1):
            if current is not None and CONT_RE.match(line):
                c = CONT_RE.match(line)
                current.fields.append((c["key"], c["value"]))
                current.raw.append(line)
                continue
            current = None
            if TASK_RE.match(line):
                try:
                    task = parse_task_line(line)
                except ParseError as exc:
                    self.errors.append((n, str(exc)))
                    self.entries.append(line)
                    continue
                task.raw = [line]
                task.position = len(self.entries)
                self.entries.append(task)
                current = task
            else:
                self.entries.append(line)

    def render(self):
        out = []
        for e in self.entries:
            out += e.render() if isinstance(e, Task) else [e]
        return "\n".join(out) + ("\n" if self.trailing_newline else "")

    # --- store interface ----------------------------------------------
    def list(self):
        return [e for e in self.entries if isinstance(e, Task)]

    def get(self, task_id):
        matches = [t for t in self.list() if t.id and (t.id == task_id or t.id.endswith(task_id))]
        if len(matches) != 1:
            raise KeyError(f"{task_id!r} matches {len(matches)} tasks")
        return matches[0]

    def add(self, repo, title, ids_in_use=(), now=None, **kw):
        task = Task(" ", repo, title, **kw)
        task.raw = None
        task.position = len(self.entries)
        self.entries.append(task)
        self.normalize(task, ids_in_use, now)
        return task

    def remove(self, task):
        self.entries.remove(task)

    def update(self, task):
        task.raw = None

    def normalize(self, task, ids_in_use=(), now=None):
        """Give a task its ID (creation time) and explicit default scores."""
        if not task.id:
            task.id = new_id({t.id for t in self.list() if t.id} | set(ids_in_use), now)
        for k, v in DEFAULTS.items():
            task.scores.setdefault(k, v)
        task.raw = None
        return task


def new_id(taken, now=None):
    base = time.strftime("%y%m%d-%H%M", time.localtime(now))
    candidate, n = base, 1
    while candidate in taken:
        n += 1
        candidate = f"{base}-{n}"
    return candidate


def id_key(task_id):
    parts = task_id.split("-")
    return (parts[0], parts[1], int(parts[2]) if len(parts) > 2 else 1)


def done_ids(done_text):
    return {w for line in done_text.splitlines() for w in line.split() if ID_RE.match(w)}


def order_key(task):
    if task.id:
        return (-task.priority, 0, id_key(task.id), task.position)
    return (-task.priority, 1, ("", "", 0), task.position)


def pick_next(doc, done_text="", cutoff=7):
    """First runnable task and a human-readable reason (PRI-3..5, SCH-1, 2)."""
    done = done_ids(done_text)
    skipped = {"waiting on you": 0, "running": 0, "parked": 0, "blocked by after:": 0}
    runnable = []
    for t in doc.list():
        if t.state == "waiting":
            skipped["waiting on you"] += 1
        elif t.state == "running":
            skipped["running"] += 1
        elif t.state == "done":
            continue
        elif t.priority < cutoff:
            skipped["parked"] += 1
        elif any(a not in done for a in t.after):
            skipped["blocked by after:"] += 1
        else:
            runnable.append(t)
    runnable.sort(key=order_key)
    notes = ", ".join(f"{n} {k}" for k, n in skipped.items() if n)
    if not runnable:
        return None, "nothing runnable" + (f" ({notes})" if notes else "")
    t = runnable[0]
    origin = f"oldest of priority {t.priority}" if t.id else "first in file order among unscored"
    reason = (f"priority {t.priority} = 2·i{t.score('i')} + u{t.score('u')}; {origin}; "
              f"{len(runnable)} runnable" + (f"; skipped {notes}" if notes else ""))
    return t, reason


def done_line(task, pr="", cost=None, seconds=None, attempts=None, today=None):
    parts = [f"{today or time.strftime('%Y-%m-%d')} {task.id} {task.repo}: {task.title}"]
    parts.append(pr or "no PR")
    parts.append(f"${cost:.2f}" if cost is not None else "$?")
    parts.append(f"{int(seconds) // 60}m{int(seconds) % 60:02d}s" if seconds is not None else "?")
    parts.append(str(attempts) if attempts is not None else "?")
    return " · ".join(parts)
