// A placeholder is not a plan (PIP-28): the planner is asked again and no plan PR is opened for it.

import { expect, test } from "vitest";
import { dataOf } from "../../src/mission.ts";
import { thinPlan } from "../../src/pipeline/plan.ts";
import { happy, intent, intents, PLAN, PLAN_BRIEF, PLAN_MD, reply, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

test("plan: a placeholder plan is refused and asked again", async () => {
  expect(thinPlan("x", "x")).toContain("placeholder");
  expect(
    thinPlan(
      "A long sentence that says what will be done but lists no step at all, anywhere in it.",
      PLAN_BRIEF,
    ),
  ).toContain("steps");
  expect(thinPlan(PLAN_MD, "x")).toContain("brief");
  expect(thinPlan(PLAN_MD, PLAN_BRIEF)).toBeNull();

  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  try {
    happy(p);
    let asked = 0;
    const good = reply(PLAN);
    p.respond.plan = (spec, prompt) => {
      asked++;
      return asked === 1 ? reply({ ...PLAN, brief: "x", plan: "x" })(spec, prompt) : good(spec, prompt);
    };
    await p.start();
    await p.until(() => asked >= 2 && Boolean(dataOf<{ plan?: { md: string } }>(p.mission()!).plan), 80);
    expect(asked).toBe(2);
    expect(dataOf<{ plan: { md: string } }>(p.mission()!).plan.md).toContain("## Steps");
  } finally {
    p.cleanup();
  }
}, 120_000);
