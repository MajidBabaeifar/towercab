// Usage limits (LOOP-9): detecting one in a failed run, parsing when it lifts, the backoff without a
// reset time, and the cooldown `machine.apply` stores for a `limit` outcome.

import { oneLine } from "./machine.ts";

/** Seconds added to a parsed reset time. */
export const RESET_MARGIN = 30;

/** Longest `Limit.text`. */
export const TEXT_MAX = 300;

/** A run that hit a usage limit: its `--model`, when it lifts (if the text says), the text. */
export interface Limit {
  model: string;
  reset: Date | null;
  text: string;
}

const DETECT =
  /rate.?limit|usage.?limit|hit your limit|limit reached|limit will reset|quota|too many requests|\b429\b|overloaded|rate_limit_error|overloaded_error/i;
const EPOCH = /\|([0-9]{10})\b/;
const RETRY_AFTER = /retry[- ]after[\s:=]+([0-9]+)/i;
const UNIT = String.raw`(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b`;
const IN = new RegExp(
  String.raw`(?:try again|retry|resets?|available again) in ([0-9]+)\s*${UNIT}(?:\s+([0-9]+)\s*${UNIT})?`,
  "i",
);
const DATETIME =
  /([0-9]{4})-([0-9]{2})-([0-9]{2})[T ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.[0-9]+)?)?([Zz]|[+-][0-9]{2}:?[0-9]{2})?/;
const CLOCK =
  /\bresets?\s+(?:at\s+|on\s+)?(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+([0-9]{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?([0-9]{1,2})(?::([0-9]{2}))?\s*(am|pm)?\b(?:\s*\(([^)]+)\))?/gi;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** The text says a usage limit was hit (case-insensitive). */
export function detectLimit(text: string): boolean {
  return DETECT.test(text);
}

/**
 * A failed run's limit: its result, else its stderr, whichever `detectLimit` matches; the reset
 * parsed from that text, the text as one line of at most 300 characters. Not failed → none.
 */
export function limitOf(
  model: string,
  failed: boolean,
  result: string,
  stderr: string,
  now: Date,
  zone?: string,
): Limit | null {
  if (!failed) return null;
  const text = [result, stderr].find(detectLimit);
  if (text === undefined) return null;
  return { model, reset: parseReset(text, now, zone), text: oneLine(text, TEXT_MAX) };
}

/** The backoff after the n-th limit without a reset time, in seconds: min(2^(n-1), 60) minutes. */
export function limitBackoff(n: number): number {
  return Math.min(2 ** Math.min(Math.max(n - 1, 0), 6), 60) * 60;
}

/**
 * The cooldown a `limit` outcome carries (`Outcome.limit`): `until` = reset + 30 s, else (no reset,
 * or one already past: a stale epoch, a log line's timestamp) now + the next backoff, counting it.
 * `backoffs` is the model's count so far (0 after a success).
 */
export function cooldown(
  limit: Limit,
  backoffs: number,
  now: number,
): { model: string; until: number; backoffs: number; text: string } {
  const reset = limit.reset ? limit.reset.getTime() / 1000 + RESET_MARGIN : null;
  if (reset !== null && reset > now) return { model: limit.model, until: reset, backoffs, text: limit.text };
  return {
    model: limit.model,
    until: now + limitBackoff(backoffs + 1),
    backoffs: backoffs + 1,
    text: limit.text,
  };
}

/** The loop's own time zone. */
export function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * When the limit lifts, from the text; the first rule that matches wins: epoch, retry-after,
 * "in N unit", a date and time, a clock time (LOOP-9). Text without a zone is in `zone` (default:
 * the loop's). A past clock time is tomorrow; a past date is next year. A time out of range → none.
 */
export function parseReset(text: string, now: Date, zone: string = localZone()): Date | null {
  const nowMs = now.getTime();
  let m = EPOCH.exec(text);
  if (m) return valid(Number(m[1]) * 1000);
  m = RETRY_AFTER.exec(text);
  if (m) return valid(nowMs + Number(m[1]) * 1000);
  m = IN.exec(text);
  if (m) {
    let secs = span(m[1]!, m[2]!);
    if (m[3] && m[4]) secs += span(m[3], m[4]);
    return valid(nowMs + secs * 1000);
  }
  m = DATETIME.exec(text);
  if (m) {
    const n = (i: number) => (m![i] === undefined ? 0 : Number(m![i]));
    const [y, mo, d, h, mi, s] = [n(1), n(2), n(3), n(4), n(5), n(6)];
    if (!validWall(y, mo, d, h, mi, s)) return null;
    const z = m[7];
    if (z === undefined) return valid(zoned(zone, y, mo, d, h, mi, s) ?? Number.NaN);
    let offset = 0;
    if (z !== "Z" && z !== "z") {
      const digits = z.slice(1).replace(":", "");
      offset = (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60_000;
      if (z.startsWith("-")) offset = -offset;
    }
    return valid(Date.UTC(y, mo - 1, d, h, mi, s) - offset);
  }
  for (const c of text.matchAll(CLOCK)) {
    const t = clock(c, nowMs, zone);
    if (t !== null) return t;
  }
  return null;
}

/** One `resets …` match → the next such time after now, or null when it isn't a time. */
function clock(c: RegExpMatchArray, nowMs: number, local: string): Date | null {
  const [, mon, day, hs, mins, ampm, zoneText] = c;
  if (!ampm && mins === undefined && mon === undefined) return null; // a bare number is no time
  const h = Number(hs);
  let hour: number;
  if (ampm) {
    if (h < 1 || h > 12) return null;
    hour = (h % 12) + (ampm.toLowerCase() === "pm" ? 12 : 0);
  } else {
    if (h > 23) return null;
    hour = h;
  }
  const minute = mins === undefined ? 0 : Number(mins);
  if (minute > 59) return null;
  let date: [number, number] | null = null;
  if (mon !== undefined && day !== undefined) {
    date = [MONTHS.indexOf(mon.toLowerCase()) + 1, Number(day)];
  }
  let zone = local;
  const z = zoneText?.trim();
  if (z && z.toLowerCase() === "utc") zone = "UTC";
  else if (z && formatter(z)) zone = z;
  return nextAt(zone, nowMs, date, hour, minute);
}

/** The next `hour:minute` in `zone` after now: today, else tomorrow; with a date this year, else next. */
function nextAt(
  zone: string,
  nowMs: number,
  date: [number, number] | null,
  hour: number,
  minute: number,
): Date | null {
  const today = wall(zone, nowMs);
  if (!today) return null;
  if (date) {
    const [mo, d] = date;
    for (const y of [today.y, today.y + 1]) {
      if (!validWall(y, mo, d, hour, minute, 0)) continue;
      const t = zoned(zone, y, mo, d, hour, minute, 0);
      if (t !== null && t > nowMs) return new Date(t);
    }
    return null;
  }
  const t = zoned(zone, today.y, today.mo, today.d, hour, minute, 0);
  if (t !== null && t > nowMs) return new Date(t);
  const next = new Date(Date.UTC(today.y, today.mo - 1, today.d + 1));
  const t2 = zoned(zone, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), hour, minute, 0);
  return t2 === null ? null : new Date(t2);
}

/** `n` of `unit` (s, m, h, d by its first letter) in seconds. */
function span(n: string, unit: string): number {
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[unit[0]!.toLowerCase()] ?? Number.NaN;
  return Number(n) * mult;
}

/** A Date for `ms`, or null when it is out of range. */
function valid(ms: number): Date | null {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

function validWall(y: number, mo: number, d: number, h: number, mi: number, s: number): boolean {
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

const formatters = new Map<string, Intl.DateTimeFormat | null>();

/** A formatter for an IANA zone, or null for an unknown zone. */
function formatter(zone: string): Intl.DateTimeFormat | null {
  if (!formatters.has(zone)) {
    let f: Intl.DateTimeFormat | null;
    try {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      });
    } catch {
      f = null;
    }
    formatters.set(zone, f);
  }
  return formatters.get(zone) ?? null;
}

interface Wall {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

/** The wall-clock time in `zone` at `ms`. */
function wall(zone: string, ms: number): Wall | null {
  const f = formatter(zone);
  if (!f) return null;
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(ms))) p[part.type] = Number(part.value);
  return { y: p.year!, mo: p.month!, d: p.day!, h: p.hour! % 24, mi: p.minute!, s: p.second! };
}

/** `zone`'s offset from UTC at `ms`, in ms. */
function offsetAt(zone: string, ms: number): number {
  const w = wall(zone, ms)!;
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

/**
 * The UTC ms of a wall-clock time in `zone`: the earlier one when a DST change repeats it, an hour
 * later when a DST change skips it.
 */
function zoned(
  zone: string,
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
): number | null {
  if (!formatter(zone)) return null;
  for (let shift = 0; shift <= 1; shift++) {
    const guess = Date.UTC(y, mo - 1, d, h + shift, mi, s);
    const offsets = new Set([offsetAt(zone, guess - 86_400_000), offsetAt(zone, guess + 86_400_000)]);
    const hits = [...offsets].map((o) => guess - o).filter((t) => offsetAt(zone, t) === guess - t);
    if (hits.length) return Math.min(...hits);
  }
  return null;
}
