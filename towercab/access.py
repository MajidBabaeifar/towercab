"""What an agent may do in each stage (RUN-6)."""
from __future__ import annotations

import fnmatch
import json
import os

READ_ONLY = ["Read", "Glob", "Grep"]
GIT_READ = ["git status*", "git diff*", "git log*", "git show*"]
SECRET_DIRS = ["~/.ssh", "~/.config/gh", "~/.aws", "~/.gnupg"]
SECRET_FILES = ["~/.claude/.credentials.json", "~/.codex/auth.json", "~/.netrc", "~/.git-credentials"]
SECRET_PATHS = SECRET_DIRS + SECRET_FILES
SECRET_GLOBS = ["**/.env", "**/.env.*"]
FORBIDDEN_BASH = ["git commit", "git push", "git remote", "git config", "gh ", "curl ", "wget ",
                  "ssh ", "scp ", "sudo "]


def deny_rules():
    rules = []
    for pattern in [d + "/**" for d in SECRET_DIRS] + SECRET_FILES:
        rules += [f"Read({pattern})", f"Edit({pattern})"]
    for g in SECRET_GLOBS:
        rules += [f"Read({g})", f"Edit({g})"]
    rules += [f"Bash({c.strip()}*)" for c in FORBIDDEN_BASH]
    return rules


def sandbox_settings():
    """Bash runs in Claude Code's sandbox: writes only in the workspace, no network, no secret reads."""
    return {"sandbox": {"enabled": True, "failIfUnavailable": True, "allowUnsandboxedCommands": False,
                        "autoAllowBashIfSandboxed": False,
                        "filesystem": {"denyRead": SECRET_PATHS}}}


def claude_argv(executable, stage, bash=(), model=None):
    """argv for one non-interactive Claude Code stage. Never bypasses permissions."""
    if stage == "build":
        tools = READ_ONLY + ["Edit", "Write", "Bash"]
        allowed = READ_ONLY + ["Edit", "Write"] + [f"Bash({c})" for c in [*GIT_READ, *bash]]
    else:  # plan, review: look, don't touch
        tools = READ_ONLY + ["Bash"]
        allowed = READ_ONLY + [f"Bash({c})" for c in GIT_READ]
    argv = [executable, "-p", "--output-format", "json", "--permission-mode", "dontAsk",
            "--tools", ",".join(tools), "--allowedTools", *allowed,
            "--disallowedTools", *deny_rules(), "--settings", json.dumps(sandbox_settings())]
    if model:
        argv += ["--model", model]
    return argv


def _expand(p):
    return os.path.expanduser(p)


def forbidden(denial):
    """A denial that touched secrets or tried to publish: the stage must stop, not carry on."""
    tool, data = denial.get("tool_name", ""), denial.get("tool_input") or {}
    if tool in ("Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "Glob", "Grep"):
        path = _expand(str(data.get("file_path") or data.get("path") or data.get("notebook_path") or ""))
        if any(path == _expand(s) or path.startswith(_expand(s).rstrip("/") + "/") for s in SECRET_PATHS):
            return True
        name = os.path.basename(path)
        return fnmatch.fnmatch(name, ".env") or fnmatch.fnmatch(name, ".env.*")
    if tool == "Bash":
        cmd = " ".join(str(data.get("command", "")).split())
        if any(cmd.startswith(c) or f"; {c}" in cmd or f"&& {c}" in cmd or f"| {c}" in cmd for c in FORBIDDEN_BASH):
            return True
        return any(s.replace("~/", "") in cmd for s in SECRET_PATHS) or ".env" in cmd.split()
    return False


def describe(denial):
    data = denial.get("tool_input") or {}
    what = data.get("command") or data.get("file_path") or data.get("path") or json.dumps(data)[:120]
    return f"{denial.get('tool_name')}: {what}"
