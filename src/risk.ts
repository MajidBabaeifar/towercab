// A change's risk (AUT-16, AUT-17, AUT-20): the risk agent's three answers, the floor code puts under
// its level, and the plain words the PR bodies and the page show. Pure; the pipeline runs the agent.

import { createHash } from "node:crypto";
import type { RiskLevel } from "./autonomy.ts";
import type { Outcome } from "./machine.ts";
import { dataOf, type Mission } from "./mission.ts";
import type { Access, RiskResult } from "./pipeline/schemas.ts";

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
  /** What was assessed (`riskKey`): the spec PR's head and the owner's answers, the plan's hash, or the code diff's patch-id. */
  of: string;
}

const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);

/** What the parts of `missions.data` the keys read look like. */
type KeyData = {
  specAnswers?: string[];
  plan?: { md: string; access: Access };
  review?: { patchId: string } | null;
  risk?: Partial<Record<RiskGate, Risk | null>>;
  riskOf?: Partial<Record<RiskGate, string>>;
};

/**
 * PIP-96: what an assessment of `gate` is of, now: the spec PR's head plus a hash of the owner's
 * answers on it (PIP-97), a hash of the plan and its access, the reviewed diff's patch-id. An
 * assessment counts only while its key is the current one.
 */
export function riskKey(m: Mission, gate: RiskGate): string {
  const d = dataOf<KeyData>(m);
  if (gate === "spec") {
    const answers = d.specAnswers ?? [];
    return answers.length ? `${m.head ?? ""}:${hash(answers)}` : (m.head ?? "");
  }
  if (gate === "plan") return hash([d.plan?.md ?? "", d.plan?.access ?? null]);
  return d.review?.patchId ?? "";
}

/** The kept assessment of `gate` if it is of the current change: undefined = none (yet). */
export function currentRisk(m: Mission, gate: RiskGate): Risk | null | undefined {
  const d = dataOf<KeyData>(m);
  if (d.riskOf?.[gate] === undefined || d.riskOf[gate] !== riskKey(m, gate)) return undefined;
  return d.risk?.[gate] ?? null;
}

/** What the code review found that the floor reads at the code gate (PIP-5). */
export interface ReviewSignal {
  door: "one-way" | "two-way";
  redLines: boolean;
}

/** What else the floor reads: the review at the code gate, the access a plan asks for. */
export interface FloorSignals {
  review?: ReviewSignal | null;
  /** The plan's access beyond the defaults (protected paths, other domains, existing tests), in words. */
  access?: string[];
}

const RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

export function higher(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * AUT-17: the lowest level the answers allow, whatever the agent said. Each of a one-way door (the
 * agent's or the review's), a large blast radius and low certainty makes it at least medium; two or
 * more make it high; a touched red line of `REVIEW.md` makes it high; a plan that asks for access
 * beyond the defaults is at least medium, so a person sees what it would be granted at a4.
 */
export function riskFloor(
  r: Pick<RiskResult, "blast_radius" | "door" | "certainty">,
  s: FloorSignals = {},
): { level: RiskLevel; because: string[] } {
  const review = s.review ?? null;
  const because: string[] = [];
  if (review?.redLines) because.push("it touches a red line of the repo's REVIEW.md");
  if (r.door.kind === "one-way" || review?.door === "one-way") because.push("it is hard to undo");
  if (r.blast_radius.size === "large") because.push("it could affect many people or systems");
  if (r.certainty.level === "low") because.push("it is hard to be sure it works once live");
  const flags = because.length - (review?.redLines ? 1 : 0);
  let level: RiskLevel = review?.redLines || flags >= 2 ? "high" : flags === 1 ? "medium" : "low";
  if (s.access?.length) {
    because.push(`the plan asks for access beyond the defaults (${s.access.join(", ")})`);
    level = higher(level, "medium");
  }
  return { level, because };
}

/** The agent's result as kept, with the floor applied (AUT-17). */
export function riskOf(v: RiskResult, of: string, s: FloorSignals = {}): Risk {
  const floor = riskFloor(v, s);
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

/** PIP-110: why a spec with open points waits, as what the owner decides. */
export function openPointsWhy(n: number): string {
  return n === 1
    ? "The spec leaves one question for you to settle before it is built."
    : `The spec leaves ${n} questions for you to settle before it is built.`;
}

const GATE_OF_WAIT: Partial<Record<string, RiskGate>> = {
  "approval:spec": "spec",
  "approval:plan": "plan",
  "approval:merge": "code",
};

/**
 * AUT-21: the owner's retry on a gate that waits because its risk check didn't finish runs the check
 * again (event `recheck`) instead of starting a new attempt; null when that isn't the case.
 */
export function recheck(m: Mission): Outcome | null {
  const gate = GATE_OF_WAIT[m.stage];
  if (!gate || currentRisk(m, gate) !== null) return null;
  const d = dataOf<KeyData>(m);
  return {
    event: "recheck",
    why: `the owner asked for the ${gate} risk check again`,
    data: {
      risk: { ...d.risk, [gate]: undefined },
      riskOf: { ...d.riskOf, [gate]: undefined },
      recheck: gate === "code" ? undefined : true,
    },
  };
}
