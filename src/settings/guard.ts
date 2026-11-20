// The ruleset guard (REPO-31): the script's own plan names the checks the ruleset requires; the ruleset is
// applied only when each has run green on the base branch's head. Towercab writes no check name.

import type { RepoConfig } from "../config.ts";
import { forgeOf } from "../github/forge.ts";
import type { RunResult } from "../tools.ts";
import type { SettingsDeps } from "./script.ts";
import type { PlanChange } from "./store.ts";

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

const text = (v: unknown): string | undefined =>
  v === undefined || v === null ? undefined : typeof v === "string" ? v : JSON.stringify(v);

const firstText = (o: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return text(o[k]);
  return undefined;
};

/**
 * REPO-38: `apply-settings --plan`'s JSON → what Apply would change, as `{what, now, after}`. The list is
 * the `changes` array (anywhere at the top: an array itself, or under `changes`); an entry is a string or an
 * object with `setting`/`what`/`name`/`key`, `now`/`current`/`from` and `after`/`to`/`want`. Null when the
 * run failed or isn't JSON; no list found is empty.
 */
export function planChanges(r: RunResult): PlanChange[] | null {
  if (r.code !== 0) return null;
  let json: unknown;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    return null;
  }
  const list = Array.isArray(json)
    ? json
    : json && typeof json === "object" && Array.isArray((json as Record<string, unknown>).changes)
      ? ((json as Record<string, unknown>).changes as unknown[])
      : [];
  const out: PlanChange[] = [];
  for (const x of list) {
    if (typeof x === "string") out.push({ what: x });
    else if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      const what = firstText(o, ["setting", "what", "name", "key"]);
      if (!what) continue;
      const now = firstText(o, ["now", "current", "from"]);
      const after = firstText(o, ["after", "to", "want"]);
      out.push({ what, ...(now !== undefined ? { now } : {}), ...(after !== undefined ? { after } : {}) });
    }
  }
  return out;
}

export interface Guard {
  ok: boolean;
  /** `Ruleset not applied: …` when not ok. */
  words: string;
}

/**
 * Every required check has a `success` run on the head of the base branch; anything unreadable is not
 * green. Read as the owner: Apply is the owner's (REPO-39).
 */
export async function mainGreen(d: SettingsDeps, repo: RepoConfig, plan: Plan | null): Promise<Guard> {
  const no = (why: string): Guard => ({ ok: false, words: `Ruleset not applied: ${why}` });
  if (!plan || plan.required.length === 0) return no("the settings plan names no required check to confirm");
  const names = plan.required.join(", ");
  const green = await forgeOf(d.github).asOwner().greenChecks(repo.github, repo.base);
  if (!green) return no(`${names} could not be confirmed on ${repo.base}`);
  const red = plan.required.filter((n) => !green.has(n));
  return red.length ? no(`${red.join(", ")} has not run green on ${repo.base}`) : { ok: true, words: "" };
}
