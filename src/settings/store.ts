// What Towercab remembers of the standard GitHub settings (REPO-30, REPO-38), in `meta`: the last check of
// each repo (`settings:<repo>`).

import type { Db } from "../db.ts";

/** A repo's checked settings: `ok`, `gaps` (the script's lines) or `unknown` (never checked). */
export interface StoredSettings {
  state: "ok" | "gaps" | "unknown";
  gaps: string[];
  /** The `ci` release the script ran from. */
  tag: string | null;
  /** Unix seconds of the last check. */
  at: number;
  /** Why the last check could not run or why something was held back; the result above stays. */
  note?: string;
  /** REPO-31: why the ruleset was not applied. */
  ruleset?: string;
  /** REPO-38: what Apply would change; absent when this `ci` release gave no readable plan. */
  plan?: PlanChange[];
}

/** One line of the plan: a setting, its value now and the value after Apply. */
export interface PlanChange {
  what: string;
  now?: string;
  after?: string;
}

export const DAY_S = 86_400;

const key = (repo: string) => `settings:${repo}`;

export function storedSettings(db: Db, repo: string): StoredSettings | null {
  const raw = db.meta(key(repo));
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<StoredSettings>;
    if (v.state !== "ok" && v.state !== "gaps" && v.state !== "unknown") return null;
    return {
      state: v.state,
      gaps: Array.isArray(v.gaps) ? v.gaps.map(String) : [],
      tag: typeof v.tag === "string" ? v.tag : null,
      at: Number(v.at) || 0,
      ...(typeof v.note === "string" ? { note: v.note } : {}),
      ...(typeof v.ruleset === "string" ? { ruleset: v.ruleset } : {}),
      ...(Array.isArray(v.plan) ? { plan: v.plan as PlanChange[] } : {}),
    };
  } catch {
    return null;
  }
}

export function saveSettings(db: Db, repo: string, s: StoredSettings): void {
  db.setMeta(key(repo), JSON.stringify(s));
}
