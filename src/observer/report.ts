// The weekly report (OBV-8): one short Telegram message on Monday after the daily run, saying what the
// observer saw, even when it proposed nothing. One outbox row per ISO week, so it is sent once.

import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import { dailyTaken, localDay, pastTime } from "./due.ts";
import { costToday, proposalsSince, runsSince, WEEK_S } from "./store.ts";

/** `2026-W46`: the ISO year and week of the local date. */
export function isoWeek(now: number): string {
  const d = new Date(now * 1000);
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const start = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - start) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

const money = (n: number) => `$${n.toFixed(2)}`;

/** The text, at most 12 lines. */
export function reportText(db: Db, config: Config, now: number, intentsRepo: string | null): string {
  const since = now - WEEK_S;
  const proposals = proposalsSince(db, since);
  const runs = runsSince(db, since);
  const held = new Map<string, true>();
  const seen = new Map<string, string>();
  let spent = 0;
  for (const r of runs) {
    spent += r.cost;
    try {
      const d = JSON.parse(r.detail) as {
        held?: { title: string }[];
        seen?: { title: string; links: string[] }[];
      };
      for (const h of d.held ?? []) held.set(h.title, true);
      for (const s of d.seen ?? []) seen.set(s.title, s.links[0] ?? "");
    } catch {
      // a detail that doesn't parse adds nothing
    }
  }
  const lines = [`Observer, week ${isoWeek(now)}:`];
  if (proposals.length === 0 && held.size === 0 && seen.size === 0) {
    lines.push("Nothing notable this week.");
  } else {
    if (proposals.length) {
      lines.push(`Proposed ${proposals.length}:`);
      for (const p of proposals.slice(0, 4))
        lines.push(`- ${p.title}${intentsRepo ? ` https://github.com/${intentsRepo}/pull/${p.pr}` : ""}`);
    }
    if (held.size) {
      lines.push(`Held back (over ${config.observer.maxProposalsPerWeek} a week):`);
      for (const t of [...held.keys()].slice(0, 2)) lines.push(`- ${t}`);
    }
    if (seen.size) {
      lines.push("Seen again, already in progress:");
      for (const [t, l] of [...seen].slice(0, 2)) lines.push(`- ${t}${l ? ` (${l})` : ""}`);
    }
  }
  lines.push(`Observer spend this week: ${money(spent)}.`);
  return lines.slice(0, 12).join("\n");
}

/**
 * On Monday, once the day's run is over (or could not start), queue the week's report. Nothing is sent
 * while the observer is off; the outbox key makes it once.
 */
export function queueReport(db: Db, config: Config, now: number, intentsRepo: string | null): boolean {
  const o = config.observer;
  if (!o.enabled || db.meta("observer.report") === localDay(now)) return false;
  if (new Date(now * 1000).getDay() !== 1 || !pastTime(now, o.dailyAt)) return false;
  if (!dailyTaken(db, now) && costToday(db, now) < o.dailyBudgetUsd) return false;
  const key = `observer:report:${isoWeek(now)}`;
  const text = reportText(db, config, now, intentsRepo);
  db.run("INSERT OR IGNORE INTO outbox (key, mission, text, created) VALUES (?, NULL, ?, ?)", key, text, now);
  db.setMeta("observer.report", `${localDay(now)}`);
  return true;
}
