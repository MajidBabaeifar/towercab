"""Recognise provider usage limits and when they lift (RUN-7)."""
from __future__ import annotations

from datetime import datetime, timedelta
import re
import time
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

LIMIT_RE = re.compile(r"rate.?limit|usage.?limit|hit your limit|limit reached|limit will reset|quota|"
                      r"too many requests|\b429\b|overloaded", re.I)
EPOCH_RE = re.compile(r"\|(\d{10})\b")
RETRY_RE = re.compile(r"retry[- ]after[\s:=]+(\d+)", re.I)
IN_RE = re.compile(r"(?:try again|retry|resets?) in (\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|h|m|s)\b", re.I)
RESET_RE = re.compile(
    r"resets?\s+(?:at\s+)?(?:(?P<mon>[A-Z][a-z]{2})\w*\s+(?P<day>\d{1,2}),?\s+(?:at\s+)?)?"
    r"(?P<h>\d{1,2})(?::(?P<m>\d{2}))?\s*(?P<ap>am|pm)?(?:\s*\((?P<tz>[^)]+)\))?", re.I)
MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug",
                                      "sep", "oct", "nov", "dec"], 1)}
UNITS = {"s": 1, "m": 60, "h": 3600}


def is_limit(text):
    return bool(LIMIT_RE.search(text or ""))


def parse_reset(text, now=None):
    """Epoch seconds when the limit lifts, or None if the text doesn't say."""
    now = time.time() if now is None else now
    text = text or ""
    if m := EPOCH_RE.search(text):
        return float(m[1])
    if m := RETRY_RE.search(text):
        return now + int(m[1])
    if m := IN_RE.search(text):
        return now + int(m[1]) * UNITS[m[2][0].lower()]
    if m := RESET_RE.search(text):
        if m["ap"] is None and m["m"] is None and m["mon"] is None:
            return None  # a bare number is not a time
        hour = int(m["h"]) % 12 + (12 if (m["ap"] or "").lower() == "pm" else 0) if m["ap"] else int(m["h"])
        if hour > 23:
            return None
        try:
            tz = ZoneInfo(m["tz"]) if m["tz"] else None
        except (ZoneInfoNotFoundError, ValueError):
            tz = None
        current = datetime.fromtimestamp(now, tz).astimezone(tz) if tz else datetime.fromtimestamp(now).astimezone()
        target = current.replace(hour=hour, minute=int(m["m"] or 0), second=0, microsecond=0)
        if m["mon"] and m["mon"][:3].lower() in MONTHS:
            target = target.replace(month=MONTHS[m["mon"][:3].lower()], day=int(m["day"]))
            if target <= current:
                target = target.replace(year=target.year + 1)
        elif target <= current:
            target += timedelta(days=1)
        return target.timestamp()
    return None
