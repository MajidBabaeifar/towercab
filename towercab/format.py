"""Pure text formats for the PR body and Telegram messages (RUN-27, RUN-28)."""
from __future__ import annotations

import re

MAX_BULLETS = 5
MAX_LINES = 4
LINE_WIDTH = 200
FEEDBACK_WIDTH = 120


def one_line(text, width):
    """First line of text, whitespace collapsed, cut with an ellipsis at width."""
    line = " ".join((text or "").split())
    return line if len(line) <= width else line[:width - 1].rstrip() + "…"


def first_sentence(text, width=FEEDBACK_WIDTH):
    text = " ".join((text or "").split())
    m = re.match(r".*?[.!?](?=\s|$)", text)
    return one_line(m.group(0) if m else text, width)


def file_bullets(name_status, limit=MAX_BULLETS):
    """`git diff --name-status` lines -> at most `limit` bullets; extra files roll into '+N more files'."""
    names = {"A": "added", "M": "changed", "D": "removed", "R": "renamed", "C": "copied"}
    files = []
    for raw in (name_status or "").splitlines():
        parts = raw.split("\t")
        if len(parts) >= 2:
            files.append(f"{names.get(parts[0][:1], 'changed')} `{parts[-1]}`")
    if len(files) <= limit:
        return files
    rest = len(files) - (limit - 1)
    return files[:limit - 1] + [f"+{rest} more files"]


def pr_body(summary, changes, verify_cmd, verify_ok, review_approved, review_feedback, task, mission,
            cost=None, seconds=None, repairs=0):
    """One-line summary, 'What changed' (≤5 bullets), 'Checks' (one line each), short footer."""
    bullets = "\n".join(f"- {c}" for c in changes[:MAX_BULLETS]) or "- no file changes"
    review = "approved" if review_approved else "not approved"
    feedback = first_sentence(review_feedback)
    footer = [f"Task `{task}`", f"mission `{mission}`"]
    if cost is not None:
        footer += [f"${cost:.2f}", f"{(seconds or 0) / 60:.1f} min"]
    if repairs:
        footer.append(f"{repairs} repairs")
    return (f"{one_line(summary, LINE_WIDTH)}\n\n"
            f"## What changed\n{bullets}\n\n"
            f"## Checks\n- Verify: {'passed' if verify_ok else 'failed'} — `{verify_cmd}`\n"
            f"- Review: {review}{' — ' + feedback if feedback else ''}\n\n"
            f"<sub>{' · '.join(footer)}</sub>")


def tg_message(emoji, title, what, action=None):
    """Line 1: emoji + title + what happened. Line 2: the one thing to do. At most 4 lines."""
    head = one_line(f"{emoji} {title}: {what}" if title else f"{emoji} {what}", LINE_WIDTH)
    if not action:
        return head
    lines = [ln.strip() for ln in str(action).strip().splitlines() if ln.strip()]
    return "\n".join([head] + [one_line(ln, LINE_WIDTH) for ln in lines[:MAX_LINES - 1]])
