// Specialist reviews (PIP-197, PIP-198): which areas a change calls in, and how a specialist's result
// joins the general review's. Pure; `review.ts` runs the agents.

import type { SpecialistPaths } from "../repo/files.ts";
import { glob, type Matcher } from "../repo/protected.ts";
import type { ReviewResult } from "./schemas.ts";

export type Area = "security" | "infra";

/** In the order they run. */
export const AREAS: Area[] = ["security", "infra"];

/** The name a specialist's findings and summary go under. */
export const AREA_PASS: Record<Area, string> = { security: "Security", infra: "Infra" };

/** The agent file of an area's specialist. */
export const AREA_AGENT = { security: "review-security", infra: "review-infra" } as const;

/** PIP-197: a path with one of these words (or its plural) is a security change. Generic on purpose. */
const SECURITY_WORDS = [
  "sandbox",
  "auth",
  "secret",
  "token",
  "credential",
  "permission",
  "crypto",
  "session",
  "password",
];

/** PIP-197: the shared infra globs. */
const INFRA_GLOBS = [
  "ansible/**",
  "deploy/**",
  "infra/**",
  "terraform/**",
  "**/Dockerfile*",
  "**/docker-compose*",
  "**/*.service",
  ".github/workflows/**",
];

/** The lower-cased words of a path: split at anything but a letter or digit, and at camelCase humps. */
function words(path: string): string[] {
  return path
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const isSecurity = (path: string) =>
  words(path).some((w) => SECURITY_WORDS.some((s) => w === s || w === `${s}s`));

/** A repo's globs as matchers; a bad glob is skipped, not an error. */
function matchers(globs: string[]): Matcher[] {
  const out: Matcher[] = [];
  for (const g of globs) {
    try {
      out.push(glob(g));
    } catch {
      // Skipped: REVIEW.md's other lines still count.
    }
  }
  return out;
}

/** PIP-197, REPO-42: the areas the changed files call in, in run order. The repo's globs only add. */
export function specialistsFor(changed: string[], repo: SpecialistPaths): Area[] {
  const files = changed.filter(Boolean);
  const infra = matchers([...INFRA_GLOBS, ...repo.infra]);
  const own = matchers(repo.security);
  const hit: Record<Area, boolean> = {
    security: files.some((f) => isSecurity(f) || own.some((m) => m(f))),
    infra: files.some((f) => infra.some((m) => m(f))),
  };
  return AREAS.filter((a) => hit[a]);
}

/**
 * PIP-198: the general review with its specialists' results joined in. A specialist's nits are dropped
 * and only its important findings, door, red lines and summary count; the general review keeps the
 * outcomes, the tests and the plan. Approved only when every one of them is.
 */
export function mergeSpecialists(
  general: ReviewResult,
  specialists: { area: Area; result: ReviewResult }[],
): ReviewResult {
  const findings = [...general.findings];
  const red = [...general.red_lines];
  let summary = general.summary.trim();
  let approved = general.approved;
  let door = general.door;
  for (const { area, result } of specialists) {
    for (const f of result.findings) {
      if (f.severity !== "important") continue;
      findings.push({ ...f, pass: f.pass.trim() || AREA_PASS[area] });
    }
    approved = approved && result.approved;
    if (result.door === "one-way") door = "one-way";
    red.push(...result.red_lines);
    if (result.summary.trim()) summary += `\n\n**${AREA_PASS[area]} review**\n\n${result.summary.trim()}`;
  }
  return { ...general, findings, red_lines: red, summary, approved, door };
}
