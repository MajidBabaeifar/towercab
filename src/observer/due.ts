// When the observer runs (OBV-2): once a day at `[observer].daily_at`, and after notable events, at most
// one event run an hour. Events are found by reading the database; nothing here moves a mission.

import { capsOf } from "../budgets.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import { budgetReached } from "../ui/state.ts";
import { costToday, metaList } from "./store.ts";

const DAILY = "observer.daily";
const PENDING = "observer.pending";
const LAST_EVENT = "observer.lastEvent";
const SEEN = "observer.seen";
const SEEDED = "observer.seeded";
/** At most one event run in this many seconds. */
export const EVENT_EVERY_S = 3_600;
const SEEN_KEEP = 500;

/** The local date `YYYY-MM-DD`. */
export function localDay(now: number): string {
  const d = new Date(now * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Whether the local time of `now` is at or past `HH:MM`. */
export function pastTime(now: number, hhmm: string): boolean {
  const d = new Date(now * 1000);
  const [h, m] = hhmm.split(":").map(Number);
  return d.getHours() * 60 + d.getMinutes() >= (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Notable events since the last look: an intent blocked on `worker budget`, the same check red three times
 * for one intent, a rollback, a spend cap reached. The first look only learns what is already there.
 */
export function scanEvents(db: Db, config: Config, now: number): void {
  const found: [string, string][] = [];
  for (const m of db.all<{ id: number }>("SELECT id FROM missions WHERE waiting = 'worker budget'"))
    found.push([`budget:${m.id}`, "budget"]);
  for (const m of db.all<{ intent: string }>("SELECT DISTINCT intent FROM missions WHERE ci_repairs >= 3"))
    found.push([`red:${m.intent}`, "red checks"]);
  for (const t of db.all<{ id: number }>(
    "SELECT id FROM transitions WHERE to_stage = 'rollback' AND at >= ?",
    now - 14 * 86_400,
  ))
    found.push([`rollback:${t.id}`, "rollback"]);
  for (const c of capsOf(db, config, now)) found.push([`cap:${localDay(now)}:${c.scope}`, "spend cap"]);

  const seen = new Set(metaList(db, SEEN));
  const fresh = found.filter(([k]) => !seen.has(k));
  const seeded = db.meta(SEEDED) !== null;
  if (seeded && fresh.length === 0) return;
  db.tx(() => {
    db.setMeta(SEEN, JSON.stringify([...seen, ...fresh.map(([k]) => k)].slice(-SEEN_KEEP)));
    db.setMeta(SEEDED, "1");
    if (!seeded) return;
    const pending = metaList(db, PENDING);
    for (const [, kind] of fresh) if (!pending.includes(kind)) pending.push(kind);
    db.setMeta(PENDING, JSON.stringify(pending));
  });
}

/**
 * The reason to run now (`daily`, or the first pending event), or null: off, the observer's own cap
 * reached, the overall budget paused, nothing due, or an event run less than an hour ago.
 */
export function nextTrigger(db: Db, config: Config, now: number): string | null {
  const o = config.observer;
  if (!o.enabled) return null;
  if (costToday(db, now) >= o.dailyBudgetUsd) return null;
  if (budgetReached(db, config, now)) return null;
  if (pastTime(now, o.dailyAt) && db.meta(DAILY) !== localDay(now)) return "daily";
  const pending = metaList(db, PENDING);
  if (pending.length && now - Number(db.meta(LAST_EVENT) ?? 0) >= EVENT_EVERY_S) return pending[0]!;
  return null;
}

/** A run starts for `trigger`: today's daily run is taken, and the events it covers are cleared. */
export function markStarted(db: Db, trigger: string, now: number): void {
  const merged = metaList(db, PENDING).length > 0;
  if (trigger === "daily") db.setMeta(DAILY, localDay(now));
  if (trigger !== "daily" || merged) db.setMeta(LAST_EVENT, String(now));
  db.delMeta(PENDING);
}

/** Whether today's daily run has started. */
export function dailyTaken(db: Db, now: number): boolean {
  return db.meta(DAILY) === localDay(now);
}
