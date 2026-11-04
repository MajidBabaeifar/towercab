// What a worker run leaves next to its rules file when the guard hook refuses (LOOP-106, LOOP-107): the
// fake Claude run calls these from its script, as the real hook would have while the worker ran.

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runGuardHook } from "../../src/pipeline/guard.ts";
import type { ChildSpec } from "../../src/tools.ts";
import { build } from "./flows.ts";

export const QUESTION = {
  context: "Every write the worker tried was refused.",
  question: "Should Towercab regenerate the build's guard settings?",
  options: [
    // biome-ignore lint/suspicious/noThenProperty: the question schema's key; never awaited.
    { option: "Yes", then: "The worker tries again." },
    // biome-ignore lint/suspicious/noThenProperty: the question schema's key; never awaited.
    { option: "No", then: "The build stays blocked." },
  ],
  recommendation: "Yes.",
};

/** A worker result that gives up and asks the owner. */
export const blocked = (over: Record<string, unknown> = {}) =>
  build({ status: "blocked", pr: null, question: QUESTION, ...over });

/** The run's folder: its stderr file sits next to `guard.json`. */
const runsOf = (spec: ChildSpec): string => dirname(spec.stderr);

/**
 * The worker's write meets the rules file an "old" loop wrote: no `version`, no `existing`. The real hook
 * reads it, so its refusal and its record are the real ones.
 */
export function oldLoopWrote(spec: ChildSpec): void {
  const file = join(runsOf(spec), "guard.json");
  const rules = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  delete rules.version;
  delete rules.existing;
  writeFileSync(file, JSON.stringify(rules));
  const r = runGuardHook(
    file,
    JSON.stringify({ tool_name: "Write", tool_input: { file_path: join(spec.cwd, "greeting.txt") } }),
  );
  if (r.code !== 2) throw new Error("the hook should have refused an old rules file");
}

/** The hook refused a write with `reason`, as it logs it. */
export function guardRefused(spec: ChildSpec, reason: string): void {
  appendFileSync(
    join(runsOf(spec), "guard-blocks.jsonl"),
    `${JSON.stringify({ at: "2026-11-04T12:00:00.000Z", path: null, reason })}\n`,
  );
}
