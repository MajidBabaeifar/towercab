"""Telegram notifications: one plain-text message per event, never fatal (RUN-12..16).
Also polls incoming messages for commands (RUN-20, RUN-21)."""
from __future__ import annotations

import json
import urllib.request


class Notifier:
    """Sends to a Telegram chat; without a token it does nothing. send() never raises."""

    def __init__(self, token=None, chat_id=None, api_base="https://api.telegram.org", timeout=10, out=print):
        self.token, self.chat_id, self.api_base, self.timeout, self.out = token, chat_id, api_base.rstrip("/"), timeout, out
        self._failing = False

    @classmethod
    def from_config(cls, config, out=print):
        tg = getattr(config, "telegram", None)
        return cls(tg.bot_token, tg.chat_id, tg.api_base, out=out) if tg else cls(out=out)

    @property
    def enabled(self):
        return bool(self.token and self.chat_id)

    def _call(self, method, payload):
        """POST to the Bot API. Returns the decoded JSON, or None on any failure (logged once per outage)."""
        req = urllib.request.Request(f"{self.api_base}/bot{self.token}/{method}", data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read()
        except Exception as exc:
            if not self._failing:   # one line per outage, not per message
                reason = str(getattr(exc, "reason", None) or exc).replace(self.token, "<token>")
                try:
                    self.out(f"telegram: {'send' if method == 'sendMessage' else method} failed ({type(exc).__name__}: {reason})")
                except Exception:
                    pass
            self._failing = True
            return None
        self._failing = False
        try:
            return json.loads(raw or b"{}")
        except ValueError:
            return {}

    def send(self, text):
        if not self.enabled:
            return False
        return self._call("sendMessage", {"chat_id": self.chat_id, "text": text[:4000]}) is not None

    def updates(self, offset=None):
        """Incoming messages as [(update_id, chat_id, text)]; [] when disabled or on any failure (RUN-20)."""
        if not self.enabled:
            return []
        payload = {"timeout": 0, "allowed_updates": ["message"]}
        if offset is not None:
            payload["offset"] = offset
        data = self._call("getUpdates", payload)
        found = []
        try:
            for u in (data or {}).get("result", []):
                msg = u.get("message") or {}
                found.append((int(u["update_id"]), str((msg.get("chat") or {}).get("id", "")), msg.get("text") or ""))
        except (AttributeError, KeyError, TypeError, ValueError):
            return found
        return found

    # --- one formatter per event ------------------------------------------
    def pr_ready(self, task, url):
        return self.send(f"✅ {task}: PR ready\n{url}")

    def stuck(self, task, stage, reason):
        return self.send(f"⛔ {task}: stuck at {stage}\n{reason.strip()[-500:]}")

    def asking(self, task, question):
        return self.send(f"❓ {task}: needs you\n{question.strip()[:500]}")

    def limit(self, provider, until):
        return self.send(f"⏳ {provider} limit hit; waiting until {until}")

    def merged(self, task, pr):
        return self.send(f"🎉 {task}: merged ({pr})")
