// UI-165..167: the parts of a multi-repo intent and its freeze, as the pages and `GET /api/state` show them.

import type { Db } from "../db.ts";
import { freezes, frozenBy } from "../freeze.ts";
import type { Mission } from "../mission.ts";
import { PART_STAGES, type PartState, partsOf } from "../parts.ts";
import type { PartView } from "./view.ts";

const WORDS: Record<string, string> = {
  build: "Building",
  verify: "Checking the build",
  proof: "Proving it works",
  publish: "Opening its PR",
  ci: "Waiting for checks",
  review: "Being reviewed",
  gate: "Ready to merge",
  deploy: "Deploying",
  e2e: "Checking live",
  rollback: "Rolling back",
  shipped: "Live",
};

/** The part's state in plain words. */
export function partWords(p: PartState, m: Mission): string {
  if (p.merged && p.stage === "gate") return "Merged";
  if (p.atGate && m.stage === "merge") return "Ready to merge";
  return WORDS[p.stage] ?? p.stage;
}

/** What the part waits for, in plain words, or null. */
export function partWait(p: PartState, m: Mission, all: PartState[]): string | null {
  if (p.waiting) return "your answer";
  if (p.merged) return null;
  if (m.stage === "merge" && (m.why ?? "").startsWith("waiting for the freeze of ")) {
    return `the freeze of ${(m.why ?? "").slice("waiting for the freeze of ".length)}`;
  }
  const before = p.waitsOn.filter((r) => all.some((x) => x.repo === r && !x.merged));
  if (p.atGate && before.length > 0) return `the part it merges after (${before.join(", ")})`;
  if (p.stage === "ci" && !p.atGate) return "a check";
  return null;
}

/** The parts of a mission, the lead first as the plan orders them (UI-165, UI-167). */
export function partViews(m: Mission, prUrl: (repo: string, n: number) => string | null): PartView[] {
  const all = partsOf(m);
  return all.map((p) => ({
    repo: p.repo,
    stage: p.stage,
    label: partWords(p, m),
    pr: p.pr,
    prUrl: p.pr === null ? null : prUrl(p.repo, p.pr),
    waitsOn: p.waitsOn,
    merged: p.merged,
    waiting: partWait(p, m, all),
  }));
}

/** UI-166: "3 repos" and the part furthest behind. */
export function repoSummary(m: Mission): { repoCount: string; slowest: string } | null {
  const all = partsOf(m);
  if (all.length === 0) return null;
  const rank = (p: PartState) => (p.merged ? 100 : p.atGate ? 50 : Math.max(0, PART_STAGES.indexOf(p.stage)));
  const slow = all.reduce((a, b) => (rank(b) < rank(a) ? b : a));
  return { repoCount: `${all.length} repos`, slowest: `${slow.repo}: ${partWords(slow, m).toLowerCase()}` };
}

/** UI-166: a mission at its merge in a repo another intent froze says so. */
export function freezeHold(db: Db, m: Mission): string | null {
  if (m.stage !== "merge" || partsOf(m).length > 0) return null;
  const by = frozenBy(db, m.repo);
  return by !== null && by !== m.id ? "waiting for the freeze" : null;
}

/** UI-165: "Merges frozen in infra, web for 2 h 5 min (limit 2 h)" while the mission holds a freeze. */
export function freezeLine(
  db: Db,
  m: Mission,
  now: number,
  limitMin: number,
  duration: (secs: number) => string,
): string | null {
  const mine = freezes(db).filter((f) => f.mission === m.id);
  if (mine.length === 0) return null;
  const since = Math.min(...mine.map((f) => f.since));
  return `Merges frozen in ${mine.map((f) => f.repo).join(", ")} for ${duration(now - since)} (limit ${duration(limitMin * 60)})`;
}
