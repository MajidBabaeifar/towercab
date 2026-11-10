// GitLab pipelines and jobs as the pipeline's checks (GL-11): one pipeline is one run, one job is one check,
// so `bucket()` of PIP-3 sorts GitLab and GitHub results alike.

import type { Check } from "../forge.ts";

type Obj = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** GitLab refused to retry a pipeline (GL-12); the message is GitLab's reason. */
export class RetryRefused extends Error {}

/** An RFC 3339 time as Unix seconds, or null. */
export function unix(s: unknown): number | null {
  const t = typeof s === "string" ? Date.parse(s) : Number.NaN;
  return Number.isNaN(t) ? null : t / 1000;
}

/**
 * One job of a pipeline as a check (GL-11), or null when it is left out: a skipped job, or a manual job
 * that is allowed to fail (GitLab's default for manual jobs). A failed job allowed to fail is NEUTRAL.
 */
export function jobCheck(pipeline: { id: number; createdAt: number | null }, job: Obj): Check | null {
  const status = str(job.status);
  const allowed = job.allow_failure === true;
  const name = str(job.name);
  const base = {
    name,
    kind: "run" as const,
    startedAt: pipeline.createdAt,
    run: pipeline.id,
    url: str(job.web_url),
  };
  switch (status) {
    case "skipped":
      return null;
    case "success":
      return { ...base, status: "COMPLETED", conclusion: "SUCCESS" };
    case "failed":
      return { ...base, status: "COMPLETED", conclusion: allowed ? "NEUTRAL" : "FAILURE" };
    case "canceled":
      return { ...base, status: "COMPLETED", conclusion: "CANCELLED" };
    case "manual":
      return allowed ? null : { ...base, status: "PENDING", conclusion: "", waitsFor: name };
    default:
      return { ...base, status: "PENDING", conclusion: "" };
  }
}
