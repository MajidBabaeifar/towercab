// Scores, order and cutoff (PRI-1..6). Computed on every read, never stored (PRI-6).

import { cmpIds } from "./intents/id.ts";
import type { Intent, Listing } from "./intents/types.ts";

/** A missing `u` or `i` counts as 3 (PRI-2); never written. */
export const DEFAULT_SCORE = 3;

/** `2 * i + u` (PRI-3), 3–15; missing scores count as 3. */
export function priority(u: number | null | undefined, i: number | null | undefined): number {
  return 2 * (i ?? DEFAULT_SCORE) + (u ?? DEFAULT_SCORE);
}

/** An intent's priority. */
export function priorityOf(x: Pick<Intent, "u" | "i">): number {
  return priority(x.u, x.i);
}

/** PRI-4: priority descending, then the oldest ID first. */
export function cmpIntents(a: Intent, b: Intent): number {
  return priorityOf(b) - priorityOf(a) || cmpIds(a.id, b.id);
}

/** PRI-5: below the cutoff is parked (a priority, or an intent's scores). */
export function isParked(p: number | Pick<Intent, "u" | "i">, cutoff: number): boolean {
  return (typeof p === "number" ? p : priorityOf(p)) < cutoff;
}

/** Waiting to be picked: open (not in `done/`), no `stage`, no `waiting`. */
export function isQueued(i: Intent): boolean {
  return !i.done && i.stage === null && i.waiting === null;
}

/** PRI-5, the picker's list: queued intents whose `after` IDs are all done, PRI-4 order, at or above the cutoff first. */
export function pickOrder(listing: Listing, cutoff: number): Intent[] {
  const runnable = listing.open
    .filter((i) => isQueued(i) && i.after.every((a) => listing.doneIds.has(a)))
    .sort(cmpIntents);
  return [...runnable.filter((i) => !isParked(i, cutoff)), ...runnable.filter((i) => isParked(i, cutoff))];
}

export interface Scores {
  u?: number;
  i?: number;
  a?: number;
}

/** PRI-1: `uN`, `iN`, `aN` words (N 1–5), each key at most once. `a0` is set in front matter only (AUT-31). */
export function parseScores(words: string[]): Scores {
  const out: Scores = {};
  for (const w of words) {
    const m = /^([uia])([1-5])$/.exec(w);
    const key = m?.[1] as keyof Scores | undefined;
    if (!m || !key || out[key] !== undefined) {
      throw new Error(`bad score ${JSON.stringify(w)}: want uN, iN or aN with N 1-5, each once`);
    }
    out[key] = Number(m[2]);
  }
  return out;
}
