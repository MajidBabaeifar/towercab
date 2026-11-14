// Costs of runs that belong to no mission (LOOP-125): the overlap check. They are kept in `meta` for 33
// days, the window the spend views read, and count in the day's and the month's spend like any other run.

import type { Db } from "./db.ts";

const KEY = "side_runs";
const KEEP_S = 33 * 86_400;

export interface SideRun {
  at: number;
  kind: string;
  cost: number;
}

/** The recorded side runs, oldest first; an unreadable value counts as none. */
export function sideRuns(db: Db): SideRun[] {
  try {
    const v = JSON.parse(db.meta(KEY) ?? "[]") as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter(
      (r): r is SideRun =>
        !!r && typeof r.at === "number" && typeof r.cost === "number" && typeof r.kind === "string",
    );
  } catch {
    return [];
  }
}

/** The side runs' costs from `since` on, `{at, cost}`, for the spend sums. */
export function sideCosts(db: Db, since: number): { at: number; cost: number }[] {
  return sideRuns(db).filter((r) => r.cost > 0 && r.at >= since);
}

/** Record one side run (one transaction), dropping the ones older than the window. */
export function recordSideRun(db: Db, run: SideRun): void {
  db.tx(() => {
    const keep = sideRuns(db).filter((r) => r.at >= run.at - KEEP_S);
    db.setMeta(KEY, JSON.stringify([...keep, run]));
  });
}
