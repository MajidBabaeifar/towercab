"""Machine config: where the task list is and how each repo is built (~/.config/towercab/config.toml)."""
from __future__ import annotations

from dataclasses import dataclass, field
import os
from pathlib import Path
import tomllib

DEFAULT_PATH = Path("~/.config/towercab/config.toml")

EXAMPLE = """\
[tasks]
remote = "https://github.com/MajidBabaeifar/gradient-tasks.git"
# path = "~/.local/share/towercab/gradient-tasks"   # Towercab's own clone
cutoff = 7

[agent]
provider = "claude"     # or "codex"
reviewer = "claude"
# model = "sonnet"      # default model; a task's @model wins
timeout = 1200          # seconds per stage
max_repairs = 2
# ci_poll = 30          # seconds between PR check polls
# ci_grace = 120        # no checks this long after a push = repo without CI

[repos.towercab]
path = "~/Repositories/towercab"
# remote = "https://github.com/MajidBabaeifar/towercab.git"   # default: origin of path
base = "main"
verify = ["python3", "-m", "unittest", "discover", "-s", "tests"]
bash = ["python3 -m unittest *", "python3 -m towercab *", "git status*", "git diff*", "git log*", "ls*", "rg *"]

# [telegram]            # notifications; see README
# bot_token = "123456:ABC..."
# chat_id = "123456789"
"""

TELEGRAM_API = "https://api.telegram.org"


class ConfigError(ValueError):
    pass


@dataclass
class RepoConfig:
    name: str
    path: Path
    verify: list
    bash: list = field(default_factory=list)
    base: str = "main"
    remote: str | None = None
    max_autonomy: int = 5


@dataclass
class TelegramConfig:
    bot_token: str
    chat_id: str
    api_base: str = TELEGRAM_API


@dataclass
class Config:
    tasks_path: Path
    tasks_remote: str | None = None
    cutoff: int = 7
    provider: str = "claude"
    reviewer: str = "claude"
    model: str | None = None
    timeout: int = 1200
    max_repairs: int = 2
    ci_poll: int = 30       # seconds between `gh pr checks` polls (PIP-3)
    ci_grace: int = 120     # no checks this long after a push = repo without CI
    repos: dict = field(default_factory=dict)
    source: Path | None = None
    telegram: TelegramConfig | None = None

    def repo(self, name):
        return self.repos.get(name)


def default_path():
    return Path(os.environ.get("TOWERCAB_CONFIG", DEFAULT_PATH)).expanduser()


def load(path=None):
    path = Path(path).expanduser() if path else default_path()
    if not path.exists():
        raise ConfigError(f"No config at {path}. Create it, e.g.:\n\n{EXAMPLE}")
    try:
        data = tomllib.loads(path.read_text())
    except tomllib.TOMLDecodeError as exc:
        raise ConfigError(f"{path}: {exc}") from None
    tasks, agent = data.get("tasks", {}), data.get("agent", {})
    if not tasks.get("remote") and not tasks.get("path"):
        raise ConfigError(f"{path}: [tasks] needs remote or path")
    repos = {}
    for name, r in data.get("repos", {}).items():
        verify = r.get("verify")
        if not r.get("path") or not isinstance(verify, list) or not verify or not all(isinstance(v, str) for v in verify):
            raise ConfigError(f"{path}: [repos.{name}] needs path and verify (a non-empty list of strings)")
        bash = r.get("bash", [])
        if not isinstance(bash, list) or not all(isinstance(b, str) for b in bash):
            raise ConfigError(f"{path}: [repos.{name}].bash must be a list of command patterns")
        repos[name] = RepoConfig(name, Path(r["path"]).expanduser(), verify, bash,
                                 r.get("base", "main"), r.get("remote"), int(r.get("max_autonomy", 5)))
    provider = agent.get("provider", "claude")
    if provider not in ("claude", "codex"):
        raise ConfigError(f"{path}: [agent].provider must be claude or codex")
    telegram = None
    if "telegram" in data:
        tg = data["telegram"]
        if not isinstance(tg, dict) or not all(isinstance(tg.get(k), str) and tg[k] for k in ("bot_token", "chat_id")):
            raise ConfigError(f"{path}: [telegram] needs bot_token and chat_id (both strings)")
        api_base = tg.get("api_base", TELEGRAM_API)
        if not isinstance(api_base, str):
            raise ConfigError(f"{path}: [telegram].api_base must be a string")
        telegram = TelegramConfig(tg["bot_token"], tg["chat_id"], api_base.rstrip("/"))
    return Config(
        tasks_path=Path(tasks.get("path", "~/.local/share/towercab/gradient-tasks")).expanduser(),
        tasks_remote=tasks.get("remote"), cutoff=int(tasks.get("cutoff", 7)),
        provider=provider, reviewer=agent.get("reviewer", provider), model=agent.get("model"),
        timeout=int(agent.get("timeout", 1200)), max_repairs=int(agent.get("max_repairs", 2)),
        ci_poll=int(agent.get("ci_poll", 30)), ci_grace=int(agent.get("ci_grace", 120)),
        repos=repos, source=path, telegram=telegram)
