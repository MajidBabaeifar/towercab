// MET-34: what an intent is expected to cost, from what the last done intents cost.

import type { Db } from "../db.ts";
import { dataOf, type Mission, patchData } from "../mission.ts";
import type { EstimateLine } from "./view.ts";

export interface Estimate {
  median: number;
  low: number;
  high: number;
  basis: "repo" | "all";
}

const round = (n: number) => Math.round(n * 100) / 100;

function quantile(sorted: number[], q: number): number {
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

function of(costs: number[], basis: Estimate["basis"]): Estimate {
  const s = [...costs].sort((a, b) => a - b);
  return {
    median: round(quantile(s, 0.5)),
    low: round(quantile(s, 0.25)),
    high: round(quantile(s, 0.75)),
    basis,
  };
}

/** The last 10 done intents of the repo; with fewer than 3, the last 10 of all repos; with fewer than 3, none. */
export function estimateFor(db: Db, repo: string): Estimate | null {
  const mine = db
    .all<{ cost_usd: number }>(
      "SELECT cost_usd FROM missions WHERE stage = 'done' AND repo = ? ORDER BY id DESC LIMIT 10",
      repo,
    )
    .map((r) => r.cost_usd);
  if (mine.length >= 3) return of(mine, "repo");
  const every = db
    .all<{ cost_usd: number }>("SELECT cost_usd FROM missions WHERE stage = 'done' ORDER BY id DESC LIMIT 10")
    .map((r) => r.cost_usd);
  return every.length >= 3 ? of(every, "all") : null;
}

/** The estimate stored in a mission when it starts, so it doesn't move while the intent runs. */
export function frozenEstimate(m: Mission): Estimate | null {
  return dataOf<{ estimate?: Estimate }>(m).estimate ?? null;
}

/** Freeze the estimate into a new mission (inside the caller's transaction). */
export function freezeEstimate(db: Db, m: Mission, now: number): Mission {
  const estimate = estimateFor(db, m.repo);
  return estimate ? patchData(db, m, { estimate }, now) : m;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/** UI-255: the line on a row: the estimate before it starts, spent against it while it runs. */
export function estimateLine(e: Estimate | null, spent: number | null): EstimateLine {
  if (spent === null || e === null) return { text: estimateText(e), pct: null, over: false };
  const over = spent > e.high;
  return {
    text: `${usd(spent)} of about ${usd(e.median)}${over ? " · over the usual range" : ""}`,
    pct: e.median > 0 ? Math.min(100, Math.round((spent / e.median) * 100)) : 100,
    over,
  };
}

/** UI-255: the line before an intent starts. */
export function estimateText(e: Estimate | null): string {
  return e ? `Estimated ${usd(e.low)}–${usd(e.high)}, about ${usd(e.median)}` : "No estimate yet";
}
