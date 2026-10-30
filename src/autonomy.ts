// Where an intent waits for the owner, and what access a worker gets (AUT-3, 4, 7, 8, 9, 11..15, 18, 19).
// Pure functions; the pipeline's handlers do the I/O.

/** The highest `a` at which the owner merges every code PR. */
export const OWNER_MERGES = 3;

/** The source that may reach a5 (AUT-13): the owner's own intents (a missing source is the owner's file). */
function ownSource(source: string | null): boolean {
  return source === null || source === "" || source === "me";
}

/** The `a` an intent without one counts as (AUT-9): full autonomy, under the caps below. */
export const DEFAULT_A = 5;

/**
 * Effective `a` (AUT-8, AUT-9, AUT-13): the minimum of `a` at pick, `a` now and the repo cap, over the
 * `a`s present; none → a5 (`DEFAULT_A`). An intent whose `source` isn't `me` gets at most 4.
 */
export function effectiveA(
  aAtPick: number | null,
  aNow: number | null,
  cap: number,
  source: string | null,
): number {
  const as = [aAtPick, aNow].filter((a): a is number => a !== null);
  const a = Math.min(...(as.length ? as : [DEFAULT_A]), cap);
  return ownSource(source) ? a : Math.min(a, 4);
}

/** A change's risk (AUT-16). */
export type RiskLevel = "low" | "medium" | "high";

export const RISK_LEVELS: readonly RiskLevel[] = ["low", "medium", "high"];

/**
 * AUT-18: whether a change at effective `a` ≥ 4 waits for the owner because of its risk: a4 → medium
 * and high wait; a5 → only high waits. No assessment (null) always waits (AUT-19).
 */
export function riskWaits(a: number, risk: RiskLevel | null): boolean {
  if (risk === null) return true;
  return a >= 5 ? risk === "high" : risk !== "low";
}

/** Why a change waits for its risk, in one plain sentence (AUT-18, AUT-19, PIP-110). */
export function riskWhy(a: number, risk: RiskLevel | null): string {
  if (risk === null) return "The risk check didn't finish, so you decide whether it goes ahead.";
  const goes = a >= 5 ? "low- and medium-risk changes go" : "only low-risk changes go";
  return `It is ${risk} risk, and at autonomy a${a} ${goes} ahead without you.`;
}

/**
 * The spec gate (AUT-11): true = the owner merges the spec PR (`approval:spec`): effective `a` ≤ 2,
 * open points from the second reviewer (PIP-97), or a risk that waits at this `a` (a3 counts like
 * a4). Else Towercab merges it once its CI passes.
 */
export function specGate(a: number, openPoints: number, risk: RiskLevel | null): boolean {
  if (a <= 2 || openPoints > 0) return true;
  return riskWaits(a, risk);
}

/**
 * The plan gate (AUT-12): true = the owner merges the plan PR (`approval:plan`): effective `a` ≤ 3,
 * or a risk that waits at this `a` (AUT-18).
 */
export function planGate(a: number, risk: RiskLevel | null): boolean {
  if (a <= OWNER_MERGES) return true;
  return riskWaits(a, risk);
}

/** What the gate decides on (PIP-7). */
export interface GateInput {
  /** Effective `a` (`effectiveA`). */
  a: number;
  /** CI green, or no CI on this repo (PIP-3). */
  ciGreen: boolean;
  /** The review's verdict, computed in code (PIP-5); null when none came back. */
  review: { approved: boolean } | null;
  /** The worker got access beyond the plan (AUT-15). */
  unplanned: boolean;
  /** A red→green proof, or none needed (PIP-30); false = `data.unproven`. */
  proven: boolean;
  /** The code's risk level after its floor (AUT-16, AUT-17); null when the assessment didn't finish. */
  risk: RiskLevel | null;
}

/** PIP-110: why the gate leaves the merge to the owner, in plain sentences. */
export const GATE_WHY = {
  ci: "GitHub's automatic checks haven't passed.",
  noReview: "The independent code review didn't finish.",
  review: "The independent code review didn't approve it, even after fix rounds.",
  access: "The agent needed access the approved plan didn't grant.",
  proof: "No test shows that the change works: none fails without it.",
} as const;

/**
 * The gate (AUT-3, AUT-4, AUT-18, PIP-7), first match → the owner merges, with why: CI not green;
 * review not approved; access beyond the plan at a4; proof missing; effective `a` ≤ 3; a risk that
 * waits at this `a`. Else Towercab merges.
 */
export function gate(g: GateInput): { merge: true } | { merge: false; why: string } {
  const hold = (why: string) => ({ merge: false as const, why });
  if (!g.ciGreen) return hold(GATE_WHY.ci);
  if (!g.review) return hold(GATE_WHY.noReview);
  if (!g.review.approved) return hold(GATE_WHY.review);
  if (g.unplanned && g.a === 4) return hold(GATE_WHY.access);
  if (!g.proven) return hold(GATE_WHY.proof);
  if (g.a <= OWNER_MERGES) return hold(`At autonomy a${g.a} you merge every change yourself.`);
  if (riskWaits(g.a, g.risk)) return hold(riskWhy(g.a, g.risk));
  return { merge: true };
}

/**
 * The `a` a worker's `lower_a` sets, if any (AUT-7): only lower, within 1–5; an intent without `a`
 * counts as a5 (AUT-9). Null = nothing is written.
 */
export function lowered(a: number | null, lowerA: number | null): number | null {
  if (lowerA === null || !Number.isInteger(lowerA) || lowerA < 1 || lowerA > 5) return null;
  return lowerA < (a ?? DEFAULT_A) ? lowerA : null;
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

/** AUT-14's table, at the effective `a`. */
export function accessPolicy(a: number): AccessPolicy {
  if (a <= OWNER_MERGES) return { network: "list", protectedPaths: "writable", request: "granted" };
  if (a === 5) return { network: "open", protectedPaths: "writable", request: "not needed" };
  return { network: "list", protectedPaths: "planned", request: "owner merges" };
}
