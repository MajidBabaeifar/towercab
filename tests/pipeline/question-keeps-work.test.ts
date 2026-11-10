// A worker that stops mid-build with a question finds its uncommitted work again after the answer (PIP-227).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { build, CODE, happy, intent, intents, TARGET } from "../helpers/flows.ts";
import { blocked } from "../helpers/hook.ts";
import { Pipe } from "../helpers/pipe.ts";

test("pipeline: a worker's question keeps its uncommitted work for the next round", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  try {
    happy(p);
    let round = 0;
    let found: string | null = null;
    p.respond.worker = (spec) => {
      round++;
      if (round === 1) return { structured: blocked(), edits: { "half-done.txt": "first half\n" } };
      const f = join(spec.cwd, "half-done.txt");
      found = existsSync(f) ? readFileSync(f, "utf8") : null;
      return { structured: build(), edits: CODE };
    };
    await p.start();
    await p.until(() => p.mission()?.waiting === "answer the question", 80);
    p.ownerComment(p.prNo("intents", p.mission()!.plan_pr!), "Yes");
    await p.until(() => round >= 2, 80);
    expect(found).toBe("first half\n");
  } finally {
    p.cleanup();
  }
}, 120_000);
