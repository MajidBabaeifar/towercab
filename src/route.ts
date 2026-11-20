// LOOP-165, LOOP-166: clear the route. Every intent past its plan is paused and waits its turn; the loop
// resumes them one per repo, where they stopped, as the repo's road clears.

import { intentPaused } from "./commands.ts";
import type { Db } from "./db.ts";
import { ORDER } from "./machine.ts";
import { type Mission, unfinished } from "./mission.ts";
import { buildingIn } from "./slots.ts";

const KEY = "route:";

/** LOOP-165: whether the intent waits its turn after a cleared route. */
export function waitsTurn(db: Db, intent: string): boolean {
  return db.meta(`${KEY}${intent}`) !== null;
}

/** LOOP-165: the intents of `repo` (every repo when null) waiting their turn. */
export function turnWaiters(db: Db, repo: string | null = null): Mission[] {
  return unfinished(db).filter((m) => (repo === null || m.repo === repo) && waitsTurn(db, m.intent));
}

/**
 * LOOP-165: pause every intent past its plan (build through merge) of `repo`, or of every repo, and mark
 * it as waiting its turn. Returns the intents it paused; one the owner had paused already is left alone.
 */
export function clearRoute(db: Db, repo: string | null, now: number): string[] {
  const ms = unfinished(db).filter((m) => repo === null || m.repo === repo);
  const out: string[] = [];
  db.tx(() => {
    for (const r of new Set(ms.map((m) => m.repo))) {
      for (const m of buildingIn(ms, r)) {
        if (intentPaused(db, m.intent)) continue;
        db.setMeta(`paused:${m.intent}`, "1");
        db.setMeta(`${KEY}${m.intent}`, String(now));
        out.push(m.intent);
      }
    }
  });
  return out;
}

/** How far a mission got: its place in the stage order (a wait counts as the stage it waits after). */
function reach(m: Mission): number {
  const s = (ORDER as readonly string[]).indexOf(m.stage);
  const from = m.from_stage ? (ORDER as readonly string[]).indexOf(m.from_stage) : -1;
  return Math.max(s, from);
}

/**
 * LOOP-166: per repo with nothing past its plan going (every mission from build through merge is paused),
 * resume the waiting intent that got furthest, then the one with the highest priority, then the oldest.
 * `prio` gives an intent's priority. Returns the intents it resumed.
 */
export function nextTurns(db: Db, prio: (intent: string) => number): string[] {
  const ms = unfinished(db);
  const out: string[] = [];
  db.tx(() => {
    for (const repo of new Set(ms.map((m) => m.repo))) {
      const going = buildingIn(ms, repo).some((m) => !intentPaused(db, m.intent));
      if (going) continue;
      const waiting = ms
        .filter((m) => m.repo === repo && waitsTurn(db, m.intent))
        .sort(
          (a, b) =>
            reach(b) - reach(a) ||
            prio(b.intent) - prio(a.intent) ||
            Number(db.meta(`${KEY}${a.intent}`)) - Number(db.meta(`${KEY}${b.intent}`)) ||
            a.id - b.id,
        );
      const next = waiting[0];
      if (!next) continue;
      db.delMeta(`paused:${next.intent}`);
      db.delMeta(`${KEY}${next.intent}`);
      out.push(next.intent);
    }
  });
  return out;
}

/** LOOP-166: a resume by the owner (`resume <id>`) also ends the wait for a turn. */
export function endTurnWait(db: Db, intent: string): void {
  db.delMeta(`${KEY}${intent}`);
}
