"""Telegram notifications: one plain-text message per event, never fatal (RUN-12..16)."""
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

    def send(self, text):
        if not self.enabled:
            return False
        body = json.dumps({"chat_id": self.chat_id, "text": text[:4000]}).encode()
        req = urllib.request.Request(f"{self.api_base}/bot{self.token}/sendMessage", data=body,
                                     headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                resp.read()
        except Exception as exc:
            if not self._failing:   # one line per outage, not per message
                reason = str(getattr(exc, "reason", None) or exc).replace(self.token, "<token>")
                try:
                    self.out(f"telegram: send failed ({type(exc).__name__}: {reason})")
                except Exception:
                    pass
            self._failing = True
            return False
        self._failing = False
        return True

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
