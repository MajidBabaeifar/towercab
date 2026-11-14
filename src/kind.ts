// An intent's kind (INT-76, INT-77, PIP-228): what sort of work it is, and so which stages it goes through.
// Pure functions; the pipeline's handlers do the I/O, and `machine.next` reads the kind from `ShipFacts`.

/** INT-76: the five kinds, heaviest first. */
export const WORK_KINDS = ["feature", "bugfix", "refactor", "infra", "spec-only"] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

export function isKind(v: unknown): v is WorkKind {
  return typeof v === "string" && (WORK_KINDS as readonly string[]).includes(v);
}

/** The kind a mission goes by (INT-77): the intent's own, else the guess kept in the mission, else `feature`. */
export function kindOf(intentKind: string | null | undefined, d: { kind?: string }): WorkKind {
  if (isKind(intentKind)) return intentKind;
  return isKind(d.kind) ? d.kind : "feature";
}

/** PIP-228: whether the kind starts at design (the spec PR) rather than at the plan. */
export function needsDesign(kind: WorkKind): boolean {
  return kind === "feature" || kind === "spec-only";
}

/** PIP-228: the stages a kind leaves out, in plain words for the page and the first PR. */
export function skippedStages(kind: WorkKind): string[] {
  switch (kind) {
    case "feature":
      return [];
    case "bugfix":
      return ["No spec PR: this is a bugfix."];
    case "refactor":
      return [
        "No spec PR: this is a refactor.",
        "No new failing test: the existing tests must stay as they are.",
      ];
    case "infra":
      return [
        "No spec PR: this is an infrastructure change.",
        "The change is tried in the sandbox instead of proven by a failing test.",
      ];
    case "spec-only":
      return ["No plan, build or code PR: merging the spec PR ends it."];
  }
}

/** INT-77: the line a first PR carries about a guessed kind; empty when the owner set the kind. */
export function kindNote(d: { kind?: string; kindWhy?: string; kindBy?: string }): string {
  if (!isKind(d.kind) || d.kindBy !== "guess") return "";
  const why = (d.kindWhy ?? "").trim();
  return `Towercab guessed this is ${d.kind === "infra" ? "an infrastructure change" : `a ${d.kind}`}${why ? `: ${why}` : ""}. Reply \`kind: <${WORK_KINDS.join("|")}>\` on this PR to change it.`;
}

/** INT-77: the owner's `kind: <value>` comment, or null when the text is anything else. */
export function parseKindComment(text: string): WorkKind | null {
  const m = /^\s*kind:\s*`?([a-z-]+)`?\s*\.?\s*$/i.exec(text);
  const v = m?.[1]?.toLowerCase();
  return isKind(v) ? v : null;
}
