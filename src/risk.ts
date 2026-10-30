// A change's risk (AUT-16, AUT-17, AUT-20): the risk agent's three answers, the floor code puts under
// its level, and the plain words the PR bodies and the page show. Pure; the pipeline runs the agent.

import type { RiskLevel } from "./autonomy.ts";
import type { RiskResult } from "./pipeline/schemas.ts";

/** The gates the risk agent assesses (PIP-96). */
export type RiskGate = "spec" | "plan" | "code";

/** One assessment as kept in `missions.data.risk.<gate>`. */
export interface Risk {
  /** The level after the floor (AUT-17): what the gates read. */
  level: RiskLevel;
  /** The level the agent gave. */
  said: RiskLevel;
  /** Why the floor raised it, in a plain sentence; null when it didn't. */
  raised: string | null;
  blast: RiskResult["blast_radius"];
  door: RiskResult["door"];
  certainty: RiskResult["certainty"];
  summary: string;
  /** PIP-97: what the owner must decide before the spec is built (the spec gate only). */
  openPoints: RiskResult["open_points"];
  /** What was assessed: the spec PR's head, the plan's hash, or the code diff's patch-id. */
  of: string;
}

/** What the code review found that the floor reads at the code gate (PIP-5). */
export interface ReviewSignal {
  door: "one-way" | "two-way";
  redLines: boolean;
}

const RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

export function higher(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * AUT-17: the lowest level the answers allow, whatever the agent said. Each of a one-way door (the
 * agent's or the review's), a large blast radius and low certainty makes it at least medium; two or
 * more make it high; a touched red line of `REVIEW.md` makes it high.
 */
export function riskFloor(
  r: Pick<RiskResult, "blast_radius" | "door" | "certainty">,
  review: ReviewSignal | null = null,
): { level: RiskLevel; because: string[] } {
  const because: string[] = [];
  if (review?.redLines) because.push("it touches a red line of the repo's REVIEW.md");
  if (r.door.kind === "one-way" || review?.door === "one-way") because.push("it is hard to undo");
  if (r.blast_radius.size === "large") because.push("it could affect many people or systems");
  if (r.certainty.level === "low") because.push("it is hard to be sure it works once live");
  const flags = because.length - (review?.redLines ? 1 : 0);
  const level: RiskLevel = review?.redLines || flags >= 2 ? "high" : flags === 1 ? "medium" : "low";
  return { level, because };
}

/** The agent's result as kept, with the floor applied (AUT-17). */
export function riskOf(v: RiskResult, of: string, review: ReviewSignal | null = null): Risk {
  const floor = riskFloor(v, review);
  const level = higher(v.level, floor.level);
  return {
    level,
    said: v.level,
    raised: level !== v.level ? `Raised from ${v.level} to ${level}: ${floor.because.join(", and ")}.` : null,
    blast: v.blast_radius,
    door: v.door,
    certainty: v.certainty,
    summary: v.summary,
    openPoints: v.open_points,
    of,
  };
}

/** AUT-20: the three answers in plain words, one line each. */
export function riskWords(r: Risk): { label: string; blast: string; door: string; certainty: string } {
  const reach = { small: "few", medium: "some", large: "many" }[r.blast.size];
  const sure = { high: "Sure", medium: "Fairly sure", low: "Not very sure" }[r.certainty.level];
  return {
    label: `${r.level.charAt(0).toUpperCase()}${r.level.slice(1)} risk`,
    blast: `Affects ${reach}: ${r.blast.who.trim()}`,
    door:
      r.door.kind === "two-way" ? `Easy to undo: ${r.door.why.trim()}` : `Hard to undo: ${r.door.why.trim()}`,
    certainty: `${sure} it works once live: ${r.certainty.why.trim()}`,
  };
}

/** AUT-20: the `## Risk` section of a PR body; undefined (not assessed yet) → "". */
export function riskMd(r: Risk | null | undefined): string {
  if (r === undefined) return "";
  if (r === null) return "## Risk\n\nThe risk check didn't finish, so you decide whether this goes ahead.";
  const w = riskWords(r);
  return [
    `## Risk: ${r.level}`,
    "An agent that didn't write this change answered three questions about it.",
    [
      `- **Who could be affected if it goes wrong:** ${w.blast}`,
      `- **Can it be undone:** ${w.door}`,
      `- **How sure we are:** ${w.certainty}`,
    ].join("\n"),
    r.summary.trim(),
    r.raised ?? "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** PIP-97: the spec PR's `## Open points for you`; none → "". */
export function openPointsMd(r: Risk | null | undefined): string {
  const points = r?.openPoints ?? [];
  if (!points.length) return "";
  return `## Open points for you\n\n${points.map((p) => `- ${p.point.trim()} ${p.why.trim()}`.trim()).join("\n")}`;
}
