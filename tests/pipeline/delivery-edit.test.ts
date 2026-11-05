// PIP-112: the delivery is read from the merged plan.md, so an owner's edit in the plan PR counts.

import { afterEach, expect, test } from "vitest";
import { DESIGN, DIR, happy, ID, intent, intents, PLAN, reply, SPEC, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

const STEP = { when: "after", text: "Turn on the repo setting", why: "only the owner can" };
let p: Pipe;
afterEach(() => p.cleanup());

async function story(planDelivery: "code" | "steps", edit: "code" | "steps") {
  p = new Pipe(TARGET, intents(intent({ a: 2 })), { keep: true });
  happy(p);
  p.respond.plan = reply({ ...PLAN, delivery: planDelivery, owner_steps: [STEP] });
  p.script(reply(DESIGN, SPEC));
  await p.start();
  let m = await p.untilStage("approval:spec");
  p.mergePr(p.prNo("web", m.spec_pr!));
  m = await p.untilStage("approval:plan");
  const pr = p.prNo("intents", m.plan_pr!);
  const md = p.show("intents", pr.head, `${DIR}/plan.md`);
  expect(md).toContain(`Delivery: ${planDelivery}`);
  p.pushTo("intents", pr.head, {
    [`${DIR}/plan.md`]: md.replace(`Delivery: ${planDelivery}`, `Delivery: ${edit}`),
  });
  p.mergePr(pr);
  return m;
}

test("pipeline: an owner's edit of the delivery from code to steps is followed", async () => {
  const m = await story("code", "steps");
  await p.untilStage("steps");
  expect(p.stages(m.id)).not.toContain("build");
  expect(p.claudeCalls.some((c) => c.kind === "worker")).toBe(false);
  expect(p.show("intents", "main", `${DIR}/plan.md`)).toContain("Delivery: steps");
}, 60_000);

test("pipeline: an owner's edit of the delivery from steps to code is followed", async () => {
  const m = await story("steps", "code");
  await p.untilStage("build");
  expect(p.stages(m.id)).not.toContain("steps");
  // The owner's edit stays in the file: nothing writes the old delivery back.
  for (let i = 0; i < 3; i++) await p.loop.pass();
  expect(p.show("intents", "main", `${DIR}/plan.md`)).toContain("Delivery: code");
  expect(ID).toBeTruthy();
}, 60_000);
