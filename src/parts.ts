// LOOP-78: the parts of a multi-repo mission. One mission (LOOP-3) keeps `data.parts`: a part per repo of
// the plan (INT-43), in landing order. Pure: the loop, the machine and the pages read parts through this.

import { dataOf, type Mission } from "./mission.ts";

/** Stages a part runs through before the mission as a whole goes on (LOOP-78). */
export type PartStage =
  | "build"
  | "verify"
  | "proof"
  | "publish"
  | "ci"
  | "review"
  | "gate"
  | "approval:merge"
  | "blocked";

export interface PartState {
  repo: string;
  stage: PartStage;
  step: string;
  /** The key of the wait this part is in (`waiting:` text), or null. */
  waiting: string | null;
  pr: number | null;
  head: string | null;
  branch: string;
  checkout: string;
  /** Repos whose parts land before this one (INT-43). */
  waitsOn: string[];
  /** The part has passed the gate. */
  atGate: boolean;
  merged: boolean;
}

/** The plan's parts as stored at plan approval: repo and what it waits on, in landing order. */
export interface PlanPart {
  repo: string;
  waitsOn: string[];
}

/** The parts of a mission, in landing order; empty for a single-repo mission. */
export function partsOf(m: Mission): PartState[] {
  const p = dataOf<{ parts?: unknown }>(m).parts;
  return Array.isArray(p) ? (p as PartState[]) : [];
}

export const isMulti = (m: Mission): boolean => partsOf(m).length > 0;

/** A part per repo of the plan, all at the start of build. Checkouts and branches are per repo. */
export function seedParts(plan: PlanPart[], m: Pick<Mission, "branch" | "checkout">): PartState[] {
  return plan.map((p) => ({
    repo: p.repo,
    stage: "build",
    step: "enter",
    waiting: null,
    pr: null,
    head: null,
    branch: m.branch,
    checkout: `${m.checkout}-${p.repo}`,
    waitsOn: p.waitsOn,
    atGate: false,
    merged: false,
  }));
}

/** The key of one unit of work: the mission, or one of its parts (children, polls and caps use it). */
export const unitKey = (m: Pick<Mission, "id">, repo?: string): string =>
  repo ? `${m.id}:${repo}` : `${m.id}`;

/** LOOP-78: the mission leaves the parallel stages when every part has passed the gate. */
export const allAtGate = (parts: PartState[]): boolean => parts.length > 0 && parts.every((p) => p.atGate);

/** Parts that still wait on the owner (a blocked wait), each by repo. */
export const waitingParts = (parts: PartState[]): PartState[] => parts.filter((p) => p.waiting !== null);

/** The repos whose parts count in `repo`'s slots: a part takes one build slot of its repo (LOOP-78). */
export const partsInRepo = (ms: Mission[], repo: string): PartState[] =>
  ms.flatMap((m) => partsOf(m).filter((p) => p.repo === repo && !p.atGate && !p.merged));

/**
 * LOOP-78: one spending cap covers the whole intent. `spent` is the mission's total over all parts (the
 * mission's `cost_usd`); the run's limit is the agent's own, lowered to what the cap leaves. `null` = no
 * limit; 0 or less = the cap is reached and no run may start.
 */
export function runBudget(
  agentUsd: number | null,
  capUsd: number,
  m: Pick<Mission, "cost_usd">,
  multi: boolean,
): number | null {
  if (!multi) return agentUsd;
  const left = capUsd - m.cost_usd;
  return agentUsd === null ? left : Math.min(agentUsd, left);
}

/** The cap is reached: every part stops at its next step and the mission asks once (LOOP-78). */
export const capReached = (capUsd: number, m: Pick<Mission, "cost_usd">): boolean => m.cost_usd >= capUsd;

/** LOOP-80: the next part to merge: the first unmerged part whose `waitsOn` repos have all merged; null when none is ready. */
export function nextToLand(parts: PartState[]): PartState | null {
  const merged = new Set(parts.filter((p) => p.merged).map((p) => p.repo));
  return (
    parts.find(
      (p) => !p.merged && p.waitsOn.every((w) => merged.has(w) || !parts.some((x) => x.repo === w)),
    ) ?? null
  );
}

/**
 * LOOP-82: the parts a red part at `repo` rolls back: it and every merged part after it in landing order,
 * last landed first. Parts before it and parts not yet merged are left alone.
 */
export function rollbackSet(parts: PartState[], repo: string): PartState[] {
  const at = parts.findIndex((p) => p.repo === repo);
  if (at < 0) return [];
  return parts
    .slice(at)
    .filter((p) => p.merged)
    .reverse();
}

/** LOOP-81: the freeze has lasted `ageSecs` and the owner is due to be asked (`freezeWaitMin` minutes). */
export const freezeDue = (ageSecs: number, freezeWaitMin: number): boolean => ageSecs >= freezeWaitMin * 60;
