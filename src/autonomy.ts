// Where an intent waits for the owner, and what access a worker gets (AUT-3, 4, 7, 8, 9, 11..15).
// Pure functions; the pipeline's handlers do the I/O.

/** The highest `a` at which the owner merges every code PR. */
export const OWNER_MERGES = 3;

/** The source that may reach a5 (AUT-13): the owner's own intents (a missing source is the owner's file). */
function ownSource(source: string | null): boolean {
  return source === null || source === "" || source === "me";
}

/**
 * Effective `a` (AUT-8, AUT-13): the minimum of `a` at pick, `a` now and the repo cap, over the
 * `a`s present; none → null. An intent whose `source` isn't `me` gets at most 4.
 */
export function effectiveA(
  aAtPick: number | null,
  aNow: number | null,
  cap: number,
  source: string | null,
): number | null {
  const as = [aAtPick, aNow].filter((a): a is number => a !== null);
  if (!as.length) return null;
  const a = Math.min(...as, cap);
  return ownSource(source) ? a : Math.min(a, 4);
}

/**
 * The spec gate (AUT-11): true = the owner merges the spec PR (`approval:spec`): a concern,
 * effective `a` ≤ 2, or no `a` and a cap ≤ 2. Else Towercab merges it once its CI passes.
 */
export function specGate(a: number | null, cap: number, concerns: boolean): boolean {
  if (concerns) return true;
  return a === null ? cap <= 2 : Math.min(a, cap) <= 2;
}

/**
 * The plan gate (AUT-12): true = the owner merges the plan PR (`approval:plan`): effective `a` ≤ 4
 * or no `a`. Only a5 (the owner's own intent, AUT-13) lets Towercab merge it.
 */
export function planGate(a: number | null, cap: number, source: string | null): boolean {
  if (a === null) return true;
  return (effectiveA(a, null, cap, source) ?? 0) <= 4;
}

/** What the gate decides on (PIP-7). */
export interface GateInput {
  /** Effective `a` (`effectiveA`). */
  a: number | null;
  /** The repo cap (`TOWERCAB.md` `max_autonomy`). */
  cap: number;
  /** CI green, or no CI on this repo (PIP-3). */
  ciGreen: boolean;
  /** The review's verdict, computed in code (PIP-5); null when none came back. */
  review: { approved: boolean; door: "one-way" | "two-way"; redLines: boolean } | null;
  /** The worker got access beyond the plan (AUT-15). */
  unplanned: boolean;
  /** A red→green proof, or none needed (PIP-30); false = `data.unproven`. */
  proven: boolean;
}

/**
 * The gate (AUT-3, AUT-4, AUT-9, PIP-7), first match → the owner merges, with why: CI not green;
 * review not approved; access beyond the plan at a4; proof missing; effective `a` ≤ 3; no `a` and
 * the repo capped at ≤ 3 or the change not low-risk. Else Towercab merges.
 */
export function gate(g: GateInput): { merge: true } | { merge: false; why: string } {
  const hold = (why: string) => ({ merge: false as const, why });
  if (!g.ciGreen) return hold("CI not green");
  if (!g.review?.approved) return hold("review not approved");
  if (g.unplanned && (g.a === 4 || g.a === null)) return hold("access beyond the plan");
  if (!g.proven) return hold("no test fails without the change");
  if (g.a !== null && g.a <= OWNER_MERGES) return hold(`autonomy a${g.a}: the owner merges`);
  if (g.a === null) {
    if (g.cap <= OWNER_MERGES) return hold(`no autonomy set and the repo caps it at ${g.cap}`);
    if (g.review.door !== "two-way" || g.review.redLines)
      return hold("no autonomy set and the change isn't low-risk");
  }
  return { merge: true };
}

/**
 * The `a` a worker's `lower_a` sets, if any (AUT-7): only lower, within 1–5; with no `a`, only
 * to 3 or less (a higher one would skip the risk judgment). Null = nothing is written.
 */
export function lowered(a: number | null, lowerA: number | null): number | null {
  if (lowerA === null || !Number.isInteger(lowerA) || lowerA < 1 || lowerA > 5) return null;
  if (a === null) return lowerA <= OWNER_MERGES ? lowerA : null;
  return lowerA < a ? lowerA : null;
}

/** What a worker may reach without asking at an effective `a` (AUT-14). */
export interface AccessPolicy {
  /** `list`: the default list plus the plan's (and, at a1–a3, mid-build requests); `open`: any domain. */
  network: "list" | "open";
  /** `writable`: every protected path but `.git`; `planned`: only those the plan grants. */
  protectedPaths: "writable" | "planned";
  /** A mid-build request: granted; granted but the PR goes to the owner; never needed. */
  request: "granted" | "owner merges" | "not needed";
}

/** AUT-14's table; no `a` is treated like a4, since Towercab may merge it (AUT-9). */
export function accessPolicy(a: number | null): AccessPolicy {
  if (a !== null && a <= OWNER_MERGES)
    return { network: "list", protectedPaths: "writable", request: "granted" };
  if (a === 5) return { network: "open", protectedPaths: "writable", request: "not needed" };
  return { network: "list", protectedPaths: "planned", request: "owner merges" };
}
