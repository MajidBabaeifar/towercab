// GitHub's `statusCheckRollup` → the forge's checks.

import type { Check } from "../forge.ts";

const unix = (s: unknown) => {
  const t = typeof s === "string" ? Date.parse(s) : Number.NaN;
  return Number.isNaN(t) ? null : t / 1000;
};
const str = (v: Record<string, unknown>, k: string) => (typeof v[k] === "string" ? (v[k] as string) : "");

/** The Actions run of a check's `detailsUrl`. */
export function runId(url: string): number | null {
  const m = /\/actions\/runs\/(\d+)(?:\/|$)/.exec(url);
  return m ? Number(m[1]) : null;
}

/** `statusCheckRollup` → checks. */
export function checksOf(rollup: unknown): Check[] {
  if (!Array.isArray(rollup)) return [];
  return rollup.map((raw) => {
    const c = raw as Record<string, unknown>;
    const startedAt = unix(c.startedAt) ?? unix(c.createdAt);
    if (c.__typename === "StatusContext" || (c.context !== undefined && c.name === undefined)) {
      const state = str(c, "state");
      return {
        name: str(c, "context"),
        kind: "status" as const,
        status: ["PENDING", "EXPECTED", ""].includes(state) ? "PENDING" : "COMPLETED",
        conclusion: state,
        startedAt,
        run: null,
        url: str(c, "targetUrl"),
      };
    }
    const url = str(c, "detailsUrl");
    return {
      name: str(c, "name"),
      kind: "run" as const,
      status: str(c, "status"),
      conclusion: str(c, "conclusion"),
      startedAt,
      run: runId(url),
      url,
    };
  });
}
