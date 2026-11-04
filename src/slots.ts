// Who holds which place in a repo (LOOP-60, LOOP-61): intents ahead of build, the build slot, and
// plan-approved intents waiting for it. Pure: the loop and the pages count with these.

import type { Listing } from "./intents/types.ts";
import { finished, phaseOf, type Stage } from "./machine.ts";
import { dataOf, type Mission } from "./mission.ts";
import { priorityOf } from "./priority.ts";

/** The time a plan-approved mission started waiting for the build slot, or null (LOOP-61). */
export function readySince(m: Mission): number | null {
  const v = dataOf<{ ready?: number }>(m).ready;
  return typeof v === "number" && phaseOf(m.stage as Stage, m.from_stage) === "plan" ? v : null;
}

export const isReady = (m: Mission): boolean => readySince(m) !== null;

const unfinished = (m: Mission) => !finished(m.stage);

/** Designed, planned or waiting for approval, not yet plan-approved (LOOP-60). */
export function isAhead(m: Mission): boolean {
  if (!unfinished(m) || isReady(m)) return false;
  const phase = phaseOf(m.stage, m.from_stage);
  return phase === "spec" || phase === "plan";
}

/** Holding the repo's build slot: building through merge (LOOP-61). */
export function isBuilding(m: Mission): boolean {
  return unfinished(m) && !m.merge_sha && phaseOf(m.stage, m.from_stage) === "code";
}

export function aheadIn(ms: Mission[], repo: string): Mission[] {
  return ms.filter((m) => m.repo === repo && isAhead(m));
}

export function buildingIn(ms: Mission[], repo: string): Mission[] {
  return ms.filter((m) => m.repo === repo && isBuilding(m));
}

/** The ready mission of `repo` that gets a free slot: highest priority, then the earliest ready. */
export function bestReady(ms: Mission[], repo: string, listing: Listing | null): Mission | null {
  const prio = (m: Mission) => {
    const i = listing?.open.find((x) => x.id === m.intent);
    return i ? priorityOf(i) : 0;
  };
  const ready = ms.filter((m) => m.repo === repo && isReady(m));
  ready.sort((a, b) => prio(b) - prio(a) || readySince(a)! - readySince(b)! || a.id - b.id);
  return ready[0] ?? null;
}
