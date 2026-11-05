// The ruleset guard (REPO-31): the script's own plan names the checks the ruleset requires; the ruleset is
// applied only when each has run green on the base branch's head. Towercab writes no check name.

import type { RepoConfig } from "../config.ts";
import { forgeOf } from "../github/forge.ts";
import type { RunResult } from "../tools.ts";
import type { SettingsDeps } from "./script.ts";

export interface Plan {
  /** Check names the ruleset would require. */
  required: string[];
  /** Branches, other than the default one, the script would change. */
  branches: string[];
}

const nameOf = (v: unknown): string | null => {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["context", "name", "check"]) if (typeof o[k] === "string") return o[k] as string;
  }
  return null;
};

/**
 * `apply-settings --plan`'s JSON → the required check names (any key like `required_checks`,
 * `required_status_checks`, `requiredChecks`, anywhere in it) and the branches it names (`branches`).
 * Null when it isn't JSON; that counts as not green.
 */
export function parsePlan(r: RunResult): Plan | null {
  if (r.code !== 0) return null;
  let json: unknown;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    return null;
  }
  const required = new Set<string>();
  const branches = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    for (const [k, val] of Object.entries(v)) {
      if (/required[_-]?(status[_-]?)?checks?$/i.test(k) && Array.isArray(val)) {
        for (const x of val) {
          const n = nameOf(x);
          if (n) required.add(n);
        }
      } else if (/^branches$/i.test(k) && Array.isArray(val)) {
        for (const x of val) if (typeof x === "string") branches.add(x);
      } else walk(val);
    }
  };
  walk(json);
  return { required: [...required], branches: [...branches] };
}

export interface Guard {
  ok: boolean;
  /** `Ruleset not applied: …` when not ok. */
  words: string;
}

/** Every required check has a `success` run on the head of the base branch; anything unreadable is not green. */
export async function mainGreen(d: SettingsDeps, repo: RepoConfig, plan: Plan | null): Promise<Guard> {
  const no = (why: string): Guard => ({ ok: false, words: `Ruleset not applied: ${why}` });
  if (!plan || plan.required.length === 0) return no("the settings plan names no required check to confirm");
  const names = plan.required.join(", ");
  const green = await forgeOf(d.github).greenChecks(repo.github, repo.base);
  if (!green) return no(`${names} could not be confirmed on ${repo.base}`);
  const red = plan.required.filter((n) => !green.has(n));
  return red.length ? no(`${red.join(", ")} has not run green on ${repo.base}`) : { ok: true, words: "" };
}
