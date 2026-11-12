// A worker that can't make its test prove the change asks the owner (PIP-30). The owner's answer is their
// say on the proof: a change that is still unproven then goes to the gate instead of asking again.

import { expect, test } from "vitest";
import { build, happy, intent, intents, TARGET } from "../helpers/flows.ts";
import { blocked } from "../helpers/hook.ts";
import { Pipe } from "../helpers/pipe.ts";

test("pipeline: an answered proof question sends the unproven change to the owner", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  try {
    happy(p);
    let round = 0;
    p.respond.worker = () => {
      round++;
      // The build adds a test that passes with or without the change; the repair round asks the owner.
      if (round === 1)
        return { structured: build(), edits: { "greeting.txt": "hello 1\n", "tests/always.sh": "true\n" } };
      if (round === 2) return { structured: blocked() };
      return { structured: build() };
    };
    await p.start();
    const asked = await p.untilStage("blocked");
    expect([asked.waiting, round], p.moves()).toEqual(["answer the question", 2]);
    p.ownerComment(p.prNo("intents", asked.plan_pr!), "Waive the proof: merge on the CI check.");
    p.clock.advance(61);
    const at = await p.untilStage("approval:merge");
    expect(at.waiting, p.moves()).toBe("review and merge PR");
    expect(JSON.parse(at.data)).toMatchObject({ unproven: true, proof: "not proven" });
    // One answer was enough: no "no changes" wait and no second question.
    expect(p.stages(at.id).filter((s) => s === "blocked")).toHaveLength(1);
  } finally {
    p.cleanup();
  }
}, 120_000);
