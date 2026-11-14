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

/** PIP-230: the repo's settings files (`REPO-*`) a spec-only design may edit besides `specs/`. */
export const SETTINGS_FILES = ["TOWERCAB.md", "CLAUDE.md", "REVIEW.md", "AGENTS.md"] as const;

/** PIP-230: whether a design of this kind may leave a change at `rel` (repo-relative). */
export function designMayEdit(kind: WorkKind, rel: string): boolean {
  if (rel === "README.md" || rel.startsWith("specs/")) return true;
  return kind === "spec-only" && (SETTINGS_FILES as readonly string[]).includes(rel);
}

/** PIP-230: the extra `--allowedTools` rules of a design of this kind. */
export function designAllow(kind: WorkKind): string[] {
  return kind === "spec-only" ? SETTINGS_FILES.map((f) => `Edit(${f})`) : [];
}

/** PIP-228: what a kind tells the design, plan or build agent about its path; empty for a feature. */
export function kindPrompt(stage: "design" | "plan" | "build", kind: WorkKind): string {
  switch (kind) {
    case "feature":
      return "";
    case "spec-only":
      if (stage !== "design") return "";
      return `This intent is a spec-only change: merging the spec PR ends it, with no plan, build or code PR. Besides \`specs/\` you may edit the repo's settings files (${SETTINGS_FILES.join(", ")}) and nothing else. If the intent needs a change to the code, or to a setting that is not in the repo, change nothing for it and say so in \`concerns\`.`;
    case "bugfix":
      if (stage === "design") return "";
      return stage === "plan"
        ? "This intent is a bugfix: there is no spec PR. Name the requirement it fixes on a `Fixes: <ID>` line, plan a failing test that shows the bug first, then the smallest fix. Wording or a `Verified by` line of that one row may change in the code PR; any other spec change means this is not a bugfix."
        : "This intent is a bugfix: there is no spec PR. Write a test that fails because of the bug, then the smallest fix that makes it pass. Touch no spec row except the one the plan names, and only its wording or its `Verified by` line.";
    case "refactor":
      if (stage === "design") return "";
      return stage === "plan"
        ? "This intent is a refactor: behaviour does not change and there is no spec PR. Plan the change so that no existing test is edited; new tests are fine. A refactor that needs an existing test or a spec file changed is not a refactor, say so in the plan."
        : "This intent is a refactor: behaviour does not change. Do not edit any existing test and do not touch `specs/`; new tests are fine. If the change cannot be made that way, stop and say so.";
    case "infra":
      if (stage === "design") return "";
      return stage === "plan"
        ? "This intent is an infrastructure or configuration change: there is no spec PR and no failing-test proof. Plan it as small, reversible steps, and keep any change to a real system as a step for the owner."
        : "This intent is an infrastructure or configuration change: there is no spec PR and no failing-test proof. Make the smallest change, run the repo's checks, and keep any change to a real system out of the code.";
  }
}
