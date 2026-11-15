// The fast lane's order (FAST-2..5): which mission of a repo holds the lane. A holder carries `data.fastLane`
// (the time it took the lane). The stamp stays while the mission waits for the owner, so it is first in line
// again when the owner decides; only the mark's removal or the mission's end clears it. Pure: the loop stamps.

import type { Intent } from "./intents/types.ts";
import { finished, WAIT_STAGES } from "./machine.ts";
import { dataOf, type Mission } from "./mission.ts";
import { cmpIntents } from "./priority.ts";

/** When the mission took the fast lane, or null (FAST-2). */
export function laneSince(m: Mission): number | null {
  const v = dataOf<{ fastLane?: number }>(m).fastLane;
  return typeof v === "number" && !finished(m.stage) ? v : null;
}

/** The mission holds its repo's fast lane. */
export const isHolder = (m: Mission): boolean => laneSince(m) !== null;

/** A holder waiting for the owner gives the lane up while it waits (FAST-2). */
const waitsOnOwner = (m: Mission): boolean => (WAIT_STAGES as readonly string[]).includes(m.stage);

/** The state of one repo's lane. */
export interface Lane {
  /** Holders that are not waiting on the owner: they keep the lane taken. */
  busy: Mission[];
  /** The fast intent that goes next (FAST-2), or null; only meaningful when `busy` is empty. */
  next: Intent | null;
  /** Fast intents of the repo that are not running in the lane, in the order they take it. */
  queued: Intent[];
}

/**
 * FAST-2: the lane of `repo`. Of the open intents marked fast, the one with a mission (it was started first)
 * and then the best priority is next.
 */
export function laneOf(ms: Mission[], open: Intent[], repo: string): Lane {
  const mine = ms.filter((m) => m.repo === repo && !finished(m.stage));
  const busy = mine.filter((m) => isHolder(m) && !waitsOnOwner(m));
  const held = new Set(mine.filter(isHolder).map((m) => m.intent));
  const started = new Set(mine.map((m) => m.intent));
  const queued = open
    .filter((i) => i.repo === repo && i.fast === true && !i.done && !held.has(i.id))
    .sort((a, b) => Number(started.has(b.id)) - Number(started.has(a.id)) || cmpIntents(a, b));
  return { busy, next: queued[0] ?? null, queued };
}

/**
 * The stamps to write now: `set` get the lane, `clear` lose it (the mark was taken off). Only a free lane
 * (no busy holder) hands out a stamp, and only to the next fast intent that already has a mission.
 */
export function stampsFor(ms: Mission[], open: Intent[]): { set: Mission[]; clear: Mission[] } {
  const set: Mission[] = [];
  const clear: Mission[] = [];
  const marked = new Map(open.map((i) => [i.id, i.fast === true]));
  for (const m of ms) if (isHolder(m) && marked.get(m.intent) === false) clear.push(m);
  for (const repo of new Set(ms.map((m) => m.repo))) {
    const lane = laneOf(
      ms.filter((m) => !clear.includes(m)),
      open,
      repo,
    );
    if (lane.busy.length > 0 || !lane.next) continue;
    const m = ms.find((x) => x.repo === repo && x.intent === lane.next!.id && !finished(x.stage));
    if (m) set.push(m);
  }
  return { set, clear };
}
