// The review kept from before a mechanical merge counts only when it is of the PR just before that merge (PIP-169).

import { expect, test } from "vitest";
import { build, CODE, happy, intent, intents, REVIEW, reply, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

const SEED = { ...TARGET, "list.txt": "a\nb\n" };
const gates = (p: Pipe) =>
  p.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM transitions WHERE to_stage = 'gate'")!.n;

test("pipeline: a review of an older head is not carried over a mechanical merge", async () => {
  const p = new Pipe(SEED, intents(intent({ a: 5 })), { keep: true });
  try {
    happy(p);
    p.queue("worker", reply(build(), { ...CODE, "list.txt": "a\nours\nb\n" }));
    p.respond.review = (_spec, prompt) => ({
      structured: prompt.includes("<resolved>")
        ? { kept_both: true, lost: [], summary: "Both sides are still there." }
        : REVIEW,
    });
    await p.start();
    await p.until(() => gates(p) === 1);
    // The kept review is of some earlier head (a fix round came after it).
    p.db.run("UPDATE missions SET data = json_set(data, '$.review.patchId', 'older-head')");
    p.pushTo("web", "main", { "list.txt": "a\ntheirs\nb\n" }, "base moves");
    p.prNo("web", p.mission()!.pr!).mergeStates.push("DIRTY");
    await p.until(() => p.mission()?.stage === "done");
    expect(p.mission()!.stage, p.moves()).toBe("done");
    const prompts = p.claudeCalls.filter((c) => c.kind === "review").map((c) => c.prompt);
    // First review, merge review, and a full review of the merged head.
    expect(prompts.filter((x) => x.includes("<resolved>"))).toHaveLength(1);
    expect(prompts.filter((x) => !x.includes("<resolved>"))).toHaveLength(2);
    expect(JSON.parse(p.mission()!.data).mech).toBeUndefined();
  } finally {
    p.cleanup();
  }
}, 120_000);
