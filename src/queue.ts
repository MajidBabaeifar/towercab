// The merge queue of a repo (LOOP-159..162): missions whose PR is ready to land, first in first out.
// Only the head lands, repairs conflicts and merges. Pure: the loop and the pages count with these.

import { finished } from "./machine.ts";
import { dataOf, type Mission } from "./mission.ts";

export type Landing = { since: number };

/** When the mission joined its repo's merge queue (stamped by `apply` on entering `merge`), or null. */
export function queuedAt(m: Mission): number | null {
  const v = dataOf<{ queuedAt?: number }>(m).queuedAt;
  return typeof v === "number" && !finished(m.stage) ? v : null;
}

/** The head's mark: it started landing and keeps its turn through a conflict round (LOOP-160). */
export function landingOf(m: Mission): Landing | null {
  const v = dataOf<{ landing?: Landing }>(m).landing;
  return v && typeof v.since === "number" && !finished(m.stage) ? v : null;
}

/** In the queue: at `merge`, or holding `landing` anywhere on its way back to `merge`. */
export function inQueue(m: Mission): boolean {
  return !finished(m.stage) && (m.stage === "merge" || landingOf(m) !== null);
}

/** The queue of `repo`, head first: the landing mission, then by `queuedAt`, then priority, then id. */
export function queueOf(ms: Mission[], repo: string, prio: (m: Mission) => number = () => 0): Mission[] {
  const at = (m: Mission) => queuedAt(m) ?? m.updated;
  return ms
    .filter((m) => m.repo === repo && inQueue(m))
    .sort(
      (a, b) =>
        Number(landingOf(b) !== null) - Number(landingOf(a) !== null) ||
        at(a) - at(b) ||
        prio(b) - prio(a) ||
        a.id - b.id,
    );
}

/** The one mission of `repo` allowed to land now, or null when its queue is empty (LOOP-159). */
export function headOf(ms: Mission[], repo: string, prio?: (m: Mission) => number): Mission | null {
  return queueOf(ms, repo, prio)[0] ?? null;
}

/** At `merge` without the landing mark: it waits its turn and holds no build slot (LOOP-162). */
export function waitsInQueue(m: Mission): boolean {
  return m.stage === "merge" && landingOf(m) === null;
}

/** The mission's place in its repo's queue, 1-based, or null when it is not queued. */
export function queuePlace(ms: Mission[], m: Mission): { n: number; of: number } | null {
  const q = queueOf(ms, m.repo);
  const i = q.findIndex((x) => x.id === m.id);
  return i < 0 ? null : { n: i + 1, of: q.length };
}

/**
 * LOOP-160: a conflict on this mission's PR is not repaired now: it is queued but not the head, or it
 * waits at `approval:merge` while another mission of its repo is landing.
 */
export function conflictHeld(ms: Mission[], m: Mission): boolean {
  if (landingOf(m) !== null) return false;
  if (m.stage === "merge") return headOf(ms, m.repo)?.id !== m.id;
  if (m.stage === "approval:merge")
    return ms.some((x) => x.id !== m.id && x.repo === m.repo && landingOf(x) !== null);
  return false;
}
