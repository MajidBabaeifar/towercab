// A run whose answer is refused gets one continue (PIP-1), and that continue is told what was wrong, so
// a people part that is too long is fixed without the owner.

import { expect, test } from "vitest";
import { dataOf } from "../../src/mission.ts";
import { happy, intent, intents, PLAN, reply, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

test("pipeline: a refused answer is asked again with the reason", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  try {
    happy(p);
    const prompts: string[] = [];
    const good = reply(PLAN);
    p.respond.plan = (spec, prompt) => {
      prompts.push(prompt);
      return prompts.length === 1
        ? reply({ ...PLAN, brief: "Too long. ".repeat(70) })(spec, prompt)
        : good(spec, prompt);
    };
    await p.start();
    await p.until(() => Boolean(dataOf<{ plan?: unknown }>(p.mission()!).plan), 80);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(
      "Your last answer was not accepted: result.brief: people part is 699 characters; the limit is 600.",
    );
    // The owner was never asked, and the reason is gone once the answer is accepted.
    expect(p.stages(p.mission()!.id)).not.toContain("blocked");
    expect(dataOf<{ refusedWhy?: unknown }>(p.mission()!).refusedWhy).toBeUndefined();
  } finally {
    p.cleanup();
  }
}, 120_000);
