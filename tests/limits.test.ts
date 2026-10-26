// Usage limits (LOOP-9): detected, reset times parsed in every format, backoff without one.

import { expect, test } from "vitest";
import { cooldown, detectLimit, limitBackoff, limitOf, parseReset } from "../src/limits.ts";

const BERLIN = "Europe/Berlin";
/** 2026-10-15 13:30 Europe/Berlin (+02:00). */
const NOW = new Date("2026-10-15T13:30:00+02:00");

/** A Berlin wall-clock time as ISO UTC. */
function berlin(y: number, mo: number, d: number, h: number, mi: number): string {
  // October and early November straddle the DST change: +02:00 until Oct 25, then +01:00.
  const summer = mo < 10 || (mo === 10 && d < 25);
  const off = summer ? "+02:00" : "+01:00";
  const p = (n: number) => String(n).padStart(2, "0");
  return new Date(`${y}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}:00${off}`).toISOString();
}
const utc = (s: string) => new Date(s).toISOString();

test("limits: reset formats", () => {
  for (const t of [
    "You've hit your limit · resets 3pm (Europe/Berlin)",
    "Claude AI usage limit reached|1760540400",
    "5-hour limit reached ∙ resets 7pm",
    "429 Too Many Requests",
    "API Error: Overloaded",
    "RATE LIMITED",
    "usage_limit",
    "Your limit will reset at 5pm",
    "quota exceeded",
    '{"type":"error","error":{"type":"rate_limit_error"}}',
    '{"type":"error","error":{"type":"overloaded_error"}}',
  ]) {
    expect(detectLimit(t), t).toBe(true);
  }
  for (const t of [
    "Authentication required",
    "Invalid API key · Please run /login",
    "error: no such file",
    "port 4290 in use",
    "",
  ]) {
    expect(detectLimit(t), t).toBe(false);
  }

  const cases: [string, string | null][] = [
    ["You've hit your limit · resets 3pm (Europe/Berlin)", berlin(2026, 10, 15, 15, 0)],
    ["limit reached ∙ resets 11am (Europe/Berlin)", berlin(2026, 10, 16, 11, 0)],
    ["weekly limit · resets Oct 17, 9:30am (Europe/Berlin)", berlin(2026, 10, 17, 9, 30)],
    ["Claude AI usage limit reached|1760540400", new Date(1_760_540_400_000).toISOString()],
    ["429 rate limit retry-after: 120", utc("2026-10-15T11:32:00Z")],
    ["rate limited, try again in 5 minutes", utc("2026-10-15T11:35:00Z")],
    ["resets in 2h 30m", utc("2026-10-15T14:00:00Z")],
    ["resets 15:00 (UTC)", utc("2026-10-15T15:00:00Z")],
    ["limit resets at 2026-10-16T09:00:00Z", utc("2026-10-16T09:00:00Z")],
    ["429 Too Many Requests", null],
    ["resets 3 things", null],
    ["Retry-After=30", utc("2026-10-15T11:30:30Z")],
    ["retry after 7", utc("2026-10-15T11:30:07Z")],
    ["retry in 45s", utc("2026-10-15T11:30:45Z")],
    ["try again in 1 hr", utc("2026-10-15T12:30:00Z")],
    ["available again in 2 days", utc("2026-10-17T11:30:00Z")],
    ["resets in 1d 2h", utc("2026-10-16T13:30:00Z")],
    ["try again in 90 seconds", utc("2026-10-15T11:31:30Z")],
    ["resets 2026-10-16T09:00:00+05:30", utc("2026-10-16T03:30:00Z")],
    ["until 2026-10-16 09:00:30-0400", utc("2026-10-16T13:00:30Z")],
    // No zone: the loop's zone.
    ["resets 2026-10-16 09:00", berlin(2026, 10, 16, 9, 0)],
    ["5-hour limit reached ∙ resets 7pm", berlin(2026, 10, 15, 19, 0)],
    ["resets at 1:15 PM", berlin(2026, 10, 16, 13, 15)],
    ["resets 12am", berlin(2026, 10, 16, 0, 0)],
    ["resets 12pm (Europe/Berlin)", berlin(2026, 10, 16, 12, 0)],
    // Another zone; an unknown one is local.
    ["resets 9am (America/New_York)", utc("2026-10-15T13:00:00Z")],
    ["resets 3pm (Mars/Olympus)", berlin(2026, 10, 15, 15, 0)],
    // Dates: ordinals, "on", "at", a month spelled out; past → next year; DST in force then.
    ["resets on November 2nd at 10am (Europe/Berlin)", utc("2026-11-02T09:00:00Z")],
    ["resets Oct. 26, 9am (Europe/Berlin)", utc("2026-10-26T08:00:00Z")],
    ["resets Jan 2, 9am (UTC)", utc("2027-01-02T09:00:00Z")],
    ["resets Oct 15, 1pm (Europe/Berlin)", utc("2027-10-15T11:00:00Z")],
    // Not times.
    ["resets 25:00", null],
    ["resets 13pm", null],
    ["resets 0am", null],
    ["resets Foo 5, 3pm", null],
    ["resets Feb 30, 3pm", null],
    ["hit your limit", null],
    ["resets 3 times, then 4", null],
    // Too far to be a time: none, never a throw.
    ["rate limit retry-after: 99999999999999", null],
    ["usage limit · resets in 99999999999 days", null],
    ["usage limit · try again in 9223372036854775807 s", null],
    // The first rule that matches wins, the first valid clock time within its rule.
    ["resets 3pm|1760540400", new Date(1_760_540_400_000).toISOString()],
    ["resets 3 times · resets 4pm", berlin(2026, 10, 15, 16, 0)],
  ];
  for (const [text, want] of cases) {
    expect(parseReset(text, NOW, BERLIN)?.toISOString() ?? null, text).toBe(want);
  }
  // The zone is what "local" means: the same clock text in Tokyo.
  expect(parseReset("resets 10pm", new Date("2026-10-15T20:30:00+09:00"), "Asia/Tokyo")?.toISOString()).toBe(
    utc("2026-10-15T13:00:00Z"),
  );
  // A clock time skipped by a DST change lands an hour later; a repeated one is the earlier.
  const spring = new Date("2026-03-29T00:00:00+01:00");
  expect(parseReset("resets 2:30am", spring, BERLIN)?.toISOString()).toBe(utc("2026-03-29T01:30:00Z"));
  const autumn = new Date("2026-10-25T00:00:00+02:00");
  expect(parseReset("resets 2:30am", autumn, BERLIN)?.toISOString()).toBe(utc("2026-10-25T00:30:00Z"));

  // A failed run's limit: its result, else its stderr; one line, at most 300 characters.
  const long = `You've hit your limit · resets 3pm (Europe/Berlin)\n${"x".repeat(400)}`;
  const l = limitOf("opus", true, long, "", NOW, BERLIN)!;
  expect(l.model).toBe("opus");
  expect(l.reset?.toISOString()).toBe(berlin(2026, 10, 15, 15, 0));
  expect(l.text).toHaveLength(300);
  expect(l.text.endsWith("x…")).toBe(true);
  expect(limitOf("sonnet", true, "error", "429 Too Many Requests", NOW, BERLIN)).toEqual({
    model: "sonnet",
    reset: null,
    text: "429 Too Many Requests",
  });
  expect(limitOf("opus", false, "usage limit reached", "", NOW)).toBeNull();
  expect(limitOf("opus", true, "compile error", "boom", NOW)).toBeNull();
});

test("limits: past reset backs off", () => {
  // Backoff without a reset time: 1, 2, 4, … 60 minutes.
  expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => limitBackoff(n) / 60)).toEqual([1, 2, 4, 8, 16, 32, 60, 60]);
  const now = NOW.getTime() / 1000;
  // A reset ahead: until = reset + 30 s, the backoff count kept.
  const ahead = limitOf("opus", true, "usage limit · try again in 5 minutes", "", NOW)!;
  expect(cooldown(ahead, 2, now)).toEqual({ model: "opus", until: now + 330, backoffs: 2, text: ahead.text });
  // A reset already past (a stale epoch) counts as none: the next backoff.
  const stale = limitOf("opus", true, "usage limit reached|1700000000", "", NOW)!;
  expect(stale.reset).not.toBeNull();
  expect(cooldown(stale, 0, now)).toMatchObject({ until: now + 60, backoffs: 1 });
  expect(cooldown(stale, 1, now)).toMatchObject({ until: now + 120, backoffs: 2 });
  // No reset at all: the same.
  const none = limitOf("haiku", true, "429 Too Many Requests", "", NOW)!;
  expect(cooldown(none, 6, now)).toMatchObject({ model: "haiku", until: now + 3600, backoffs: 7 });
});
