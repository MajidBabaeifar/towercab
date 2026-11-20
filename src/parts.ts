// LOOP-78: the parts of a multi-repo mission. One mission (LOOP-3) keeps `data.parts`: a part per repo of
// the plan (INT-43), in landing order. Pure: the loop, the machine and the pages read parts through this.

import { randomUUID } from "node:crypto";
import type { SqlValue } from "./db.ts";
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
  | "blocked"
  // LOOP-80: the stages a part passes while the mission lands its parts.
  | "deploy"
  | "e2e"
  | "rollback"
  | "shipped";

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
  /** Mission columns this part keeps for itself (repairs, session, retry_at...), laid over the mission's row. */
  cols?: Record<string, SqlValue>;
  /** The part's own pipeline data (`missions.data` keys), laid over the mission's. */
  data?: Record<string, unknown>;
}

/** The mission stages in which its parts are driven, each on its own (LOOP-78). */
export const PART_STAGES: readonly string[] = ["build", "verify", "proof", "publish", "ci", "review", "gate"];

/**
 * The mission is in the parts: at a stage of theirs, or blocked on the owner by one of them (the other
 * parts go on while it waits).
 */
export const inPartStages = (m: Mission): boolean =>
  isMulti(m) &&
  (PART_STAGES.includes(m.stage) ||
    (m.stage === "blocked" && m.from_stage !== null && PART_STAGES.includes(m.from_stage)));

/** The mission stages in which its parts land, one at a time and in order (LOOP-80). */
export const LANDING_STAGES: readonly string[] = ["merge", "deploy", "e2e", "rollback"];

/** The mission is landing its parts: merging, deploying or checking them live, or rolling them back. */
export const inLanding = (m: Mission): boolean => isMulti(m) && LANDING_STAGES.includes(m.stage);

/** LOOP-80: the part the landing works on now, or null. */
export function currentPart(m: Mission, parts: PartState[]): PartState | null {
  if (m.stage === "merge") return nextToLand(parts);
  if (m.stage === "rollback") return [...parts].reverse().find((p) => p.stage === "rollback") ?? null;
  return parts.find((p) => p.stage === "deploy" || p.stage === "e2e") ?? null;
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
    step: "",
    waiting: null,
    pr: null,
    head: null,
    branch: m.branch,
    checkout: `${m.checkout}-${p.repo}`,
    waitsOn: p.waitsOn,
    atGate: false,
    merged: false,
    cols: { session: randomUUID() },
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
  ms.flatMap((m) => partsOf(m).filter((p) => p.repo === repo && !p.merged));

/** Does the mission take a slot of `repo`'s: its own repo, or the repo of a part not yet merged (LOOP-78)? */
export const takesSlotIn = (m: Mission, repo: string): boolean =>
  isMulti(m) ? partsOf(m).some((p) => p.repo === repo && !p.merged) : m.repo === repo;

/**
 * LOOP-78: one spending cap covers the whole intent. `spent` is the mission's total over all parts (the
 * mission's `cost_usd`); the run's limit is the agent's own, lowered to what the cap leaves. `null` = no
 * limit; 0 or less = the cap is reached and no run may start.
 */
export function runBudget(
  agentUsd: number | null,
  capUsd: number,
  m: Pick<Mission, "cost_usd"> & { data?: string },
  multi: boolean,
): number | null {
  if (!multi) return agentUsd;
  const left = capUsd - spentOf(m);
  return agentUsd === null ? left : Math.min(agentUsd, left);
}

/** The cap is reached: every part stops at its next step and the mission asks once (LOOP-78). */
export const capReached = (capUsd: number, m: Pick<Mission, "cost_usd"> & { data?: string }): boolean =>
  spentOf(m) >= capUsd;

/** What counts against the cap: the spend since the owner last let the parts carry on (`capBase`). */
function spentOf(m: Pick<Mission, "cost_usd"> & { data?: string }): number {
  const base = m.data ? Number(dataOf({ data: m.data } as Mission).capBase) || 0 : 0;
  return m.cost_usd - base;
}

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

/**
 * LOOP-80: the mission no longer needs its freeze: it ended (done, unverified, dropped), or it went back to
 * its parts (a rollback finished and the rolled-back parts are built again). While it merges, deploys, checks
 * live or rolls back, and while it waits for the owner from one of those, the freeze holds.
 */
export const freezeOver = (m: Mission): boolean =>
  ["done", "stopped", "unverified"].includes(m.stage) ||
  PART_STAGES.includes(m.stage) ||
  (m.stage === "blocked" && m.from_stage !== null && PART_STAGES.includes(m.from_stage));
