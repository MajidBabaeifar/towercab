"""PR description: Haiku writes it from the builder's notes and review verdict; a plain template if it can't (PIP-11, PIP-14, PIP-15)."""
from __future__ import annotations

import subprocess

MAX_BULLETS = 5
FOOTER = "🤖 Built by Towercab"

PROMPT = """Write a pull request description. Reply with markdown only, in exactly this shape:

<one-line summary>

## What changed
- <behaviour, not files; at most 5 bullets>

Be terse; fragments are fine. No preamble, no checks section.

Task: {title}

Builder's notes:
{build}

Review verdict:
{review}
"""


def bullets(text, limit=MAX_BULLETS):
    """Up to `limit` non-empty lines as '- ' bullets."""
    lines = [l.strip().lstrip("-*• ").strip() for l in text.strip().splitlines()]
    return "\n".join(f"- {l[:200]}" for l in [l for l in lines if l][:limit]) or "- see review"


def checks(verify, repairs, ci=None):
    """ci: the PR's CI result ("green", or why nothing ran); None = the local verify gated."""
    gate = f"- CI: {ci} ({repairs} repairs)" if ci else f"- verify: `{verify}` passed ({repairs} repairs)"
    return f"## Checks\n{gate}\n- reviewer agent approved"


def assemble(m, summary, changes, verify, usage, ci=None):
    """What matters first: summary, changes, checks. Bookkeeping goes in a small footer."""
    footer = f"<sub>{FOOTER} · task `{m['task']}` · mission `{m['id']}` · {usage}</sub>"
    return f"{summary}\n\n## What changed\n{changes}\n\n{checks(verify, m['repairs'], ci)}\n\n{footer}"


def plain_body(m, title, review, verify, usage, ci=None):
    """Deterministic fallback: title as summary, review feedback as bullets (PIP-15)."""
    return assemble(m, title, bullets(review), verify, usage, ci)


def parse(text):
    """(summary, bullets) from the model's reply, or None if it isn't in the asked shape."""
    head, sep, rest = text.strip().partition("## What changed")
    summary = head.strip().splitlines()[0].strip() if head.strip() else ""
    if not summary or not sep:
        return None
    items = [l.strip() for l in rest.splitlines() if l.strip().startswith(("-", "*"))]
    if not items:
        return None
    return summary[:200], bullets("\n".join(items))


def write_body(claude, m, title, build, review, verify, usage, timeout=60, ci=None):
    """Haiku-written body; any failure falls back to plain_body."""
    fallback = plain_body(m, title, review, verify, usage, ci)
    argv = [claude, "-p", "--model", "haiku", "--tools", "", "--output-format", "text"]
    prompt = PROMPT.format(title=title, build=build.strip()[-6000:] or "(none)", review=review.strip()[:3000] or "(none)")
    try:
        r = subprocess.run(argv, input=prompt, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return fallback
    parsed = parse(r.stdout) if r.returncode == 0 else None
    if not parsed:
        return fallback
    return assemble(m, parsed[0], parsed[1], verify, usage, ci)
