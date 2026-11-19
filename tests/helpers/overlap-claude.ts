// A fake `claude` child that answers the overlap check (INT-73) with the given matches.

import { writeFileSync } from "node:fs";
import type { ChildExit, ChildSpec } from "../../src/tools.ts";

export interface OverlapAnswer {
  matches?: { kind: string; ref: string; how: string }[];
  title_note?: string;
}

/** What `claude -p --output-format json` prints for an overlap run; `code` is the child's exit code. */
export function overlapChild(answer: OverlapAnswer | string = {}, cost = 0.04, code = 0) {
  return (spec: ChildSpec): ChildExit => {
    const structured = typeof answer === "string" ? answer : { matches: [], title_note: "", ...answer };
    writeFileSync(
      spec.stdout,
      `${JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "",
        session_id: "s",
        total_cost_usd: cost,
        duration_ms: 5,
        permission_denials: [],
        modelUsage: {},
        structured_output: structured,
      })}\n`,
    );
    writeFileSync(spec.stderr, "");
    return { code, signal: null };
  };
}
