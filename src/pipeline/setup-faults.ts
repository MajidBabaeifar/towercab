// The known setup errors (LOOP-107): the ways Towercab's own setup (the guard's rules file, the
// sandbox) can leave a worker blocked. A block that matches an entry is retried once before the owner is
// asked. The list is fixed on purpose: it reads only what Towercab itself holds (the hook's own refusal
// reasons, the sandbox's output), never the worker's account of why it stopped. A new kind of setup
// fault becomes a new entry when it is seen.

import { classifyRun } from "../faults.ts";

/** What Towercab saw of a run, from its own logs. */
export interface SetupEvidence {
  /** The reasons the guard hook logged for its refusals (`guard-blocks.jsonl`). */
  guardReasons: string[];
  /** The run's stderr file and the build's setup log: what the sandbox and the tools printed. */
  output: string[];
}

export interface SetupFault {
  id: string;
  /** What to tell the owner, in plain words. */
  plain: string;
  matches(e: SetupEvidence): boolean;
}

/** The hook failed closed on a rules file it could not read (`guard: <reason>: blocked`). */
const UNREADABLE = /^guard: .*(?:ENOENT|EACCES|EISDIR|SyntaxError|Unexpected (?:token|end)|JSON).*: blocked$/;

/** The hook read a rules file of its version that lacks or misstates a key. */
const MALFORMED = /^guard: .*(?: missing|not absolute|not an object).*: blocked$/;

export const SETUP_FAULTS: readonly SetupFault[] = [
  {
    id: "guard-rules-unreadable",
    plain: "the guard could not read the rules file Towercab wrote for the run",
    matches: (e) => e.guardReasons.some((r) => UNREADABLE.test(r)),
  },
  {
    id: "guard-rules-malformed",
    plain: "the guard refused the rules file Towercab wrote for the run",
    matches: (e) => e.guardReasons.some((r) => MALFORMED.test(r)),
  },
  {
    id: "sandbox-start",
    plain: "the sandbox the run works in did not start",
    matches: (e) => e.output.some((t) => classifyRun(t)?.kind === "sandbox"),
  },
];

/** The first known setup error the evidence shows, or null: then the block is the work's own. */
export function setupFault(e: SetupEvidence): SetupFault | null {
  return SETUP_FAULTS.find((f) => f.matches(e)) ?? null;
}
