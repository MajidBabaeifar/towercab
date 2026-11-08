// Who holds which place in a repo (LOOP-60, LOOP-61): intents ahead of build, the build slot, and
// plan-approved intents waiting for it. Pure: the loop and the pages count with these.

import type { Listing } from "./intents/types.ts";
import { finished, isWorking, phaseOf, type Stage, WAIT_STAGES } from "./machine.ts";
import { dataOf, type Mission } from "./mission.ts";
import { priorityOf } from "./priority.ts";
import { waitsInQueue } from "./queue.ts";

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

/** An intent ahead that waits for the owner: an approval or a block (LOOP-100). */
export function isWaitingOnOwner(m: Mission): boolean {
  return isAhead(m) && (WAIT_STAGES as readonly string[]).includes(m.stage);
}

/** Intents ahead that are being designed or planned: they take a place (LOOP-100). */
export function workingAheadIn(ms: Mission[], repo: string): Mission[] {
  return aheadIn(ms, repo).filter((m) => !isWaitingOnOwner(m));
}

/** Intents ahead that wait for the owner: they take no place, only count toward the cap (LOOP-100). */
export function ownerAheadIn(ms: Mission[], repo: string): Mission[] {
  return aheadIn(ms, repo).filter(isWaitingOnOwner);
}

export function buildingIn(ms: Mission[], repo: string): Mission[] {
  return ms.filter((m) => m.repo === repo && isBuilding(m));
}

/** LOOP-110: missions between build and merge per repo, working and waiting together, are at most this many. */
export const capOf = (workers: number): number => 3 * workers;

/**
 * LOOP-110: a mission from build through merge that only waits holds no slot: it is at `approval:merge`,
 * blocked in the code phase, waiting on the owner's steps, or `data.idle` is set (polling CI or a review
 * with no run going, or just back from a wait for the owner). The mark stays until the mission's next
 * run starts, so a later stage that finishes without a run still counts as idle; only a run takes a slot.
 */
export function isIdle(m: Mission): boolean {
  if (!isBuilding(m)) return false;
  if (m.stage === "approval:merge" || m.stage === "blocked") return true;
  if (m.stage === "steps" && m.waiting !== null) return true;
  // LOOP-162: queued to merge behind the head.
  if (waitsInQueue(m)) return true;
  return dataOf<{ idle?: boolean }>(m).idle === true;
}

/** LOOP-117: at build, waiting for the intents its intent file says it comes after: asks for no slot. */
export function heldByAfter(m: Mission): boolean {
  return m.stage === "build" && isBuilding(m) && dataOf<{ afterHold?: unknown }>(m).afterHold !== undefined;
}

/** LOOP-111: an idle mission whose next run was asked for while every slot was taken. */
export function returningSince(m: Mission): number | null {
  const v = dataOf<{ returning?: number }>(m).returning;
  return isBuilding(m) && isWorking(m.stage) && !heldByAfter(m) && typeof v === "number" ? v : null;
}

/** Building through merge and doing work: these fill a repo's `workers` slots (LOOP-110). */
export function workingIn(ms: Mission[], repo: string): Mission[] {
  return buildingIn(ms, repo).filter((m) => !isIdle(m));
}

export function idleIn(ms: Mission[], repo: string): Mission[] {
  return buildingIn(ms, repo).filter(isIdle);
}

const prioOf = (listing: Listing | null) => (m: Mission) => {
  const i = listing?.open.find((x) => x.id === m.intent);
  return i ? priorityOf(i) : 0;
};

/** LOOP-115: the owner answered a wait and the change is back in build: it goes first in line for a slot. */
export function isAnswered(m: Mission): boolean {
  return isBuilding(m) && dataOf<{ answered?: boolean }>(m).answered === true;
}

/** A mission at `build` outside the slots whose step has not yet asked for one (LOOP-115). */
function wantsBuild(m: Mission): boolean {
  return (
    (m.stage === "build" || m.stage === "ci") &&
    !heldByAfter(m) &&
    isIdle(m) &&
    dataOf<{ idle?: boolean }>(m).idle === true
  );
}

/**
 * Missions of `repo` waiting for a slot for their next run, first in line first: answered ones, then by
 * priority (LOOP-111, LOOP-115). A mission back at `build` counts from the moment it is back.
 */
export function returningIn(ms: Mission[], repo: string, listing: Listing | null): Mission[] {
  const prio = prioOf(listing);
  const since = (m: Mission) => returningSince(m) ?? m.updated;
  return ms
    .filter((m) => m.repo === repo && (returningSince(m) !== null || wantsBuild(m)))
    .sort(
      (a, b) =>
        Number(isAnswered(b)) - Number(isAnswered(a)) ||
        prio(b) - prio(a) ||
        since(a) - since(b) ||
        a.id - b.id,
    );
}

/** LOOP-116: the working mission at `ci` that waits for GitHub's checks, with no run going. */
export function waitsForCi(m: Mission): boolean {
  return m.stage === "ci" && isBuilding(m) && !isIdle(m) && m.child_pid === null;
}

/** The ready mission of `repo` that gets a free slot: highest priority, then the earliest ready. */
export function bestReady(ms: Mission[], repo: string, listing: Listing | null): Mission | null {
  const prio = prioOf(listing);
  const ready = ms.filter((m) => m.repo === repo && isReady(m));
  ready.sort((a, b) => prio(b) - prio(a) || readySince(a)! - readySince(b)! || a.id - b.id);
  return ready[0] ?? null;
}
