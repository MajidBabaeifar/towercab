import { afterAll, beforeAll, expect, test } from "vitest";
import { applyCommand, insertCommand } from "../../src/commands.ts";
import { DESIGN, happy, ID, intent, intents, PLAN, reply, SPEC, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

let p: Pipe;
beforeAll(async () => {
  p = new Pipe(TARGET, intents(intent({ a: 2 })), { keep: true });
  happy(p);
  p.respond.plan = reply({
    ...PLAN,
    owner_steps: [{ when: "before", text: "Add the secret", why: "only the owner can" }],
  });
  p.script(reply(DESIGN, SPEC));
  await p.start();
}, 30_000);
afterAll(() => p.cleanup());

test("pipeline: switching to steps with only before-merge steps waits for the owner", async () => {
  let m = await p.untilStage("approval:spec");
  p.mergePr(p.prNo("web", m.spec_pr!));
  m = await p.untilStage("approval:plan");
  p.mergePr(p.prNo("intents", m.plan_pr!));
  m = await p.untilStage("blocked");
  p.db.run(
    "UPDATE missions SET stage = 'blocked', waiting = 'answer the question', from_stage = 'build' WHERE id = ?",
    m.id,
  );
  const now = p.clock.now();
  const row = {
    id: insertCommand(p.db, { name: "steps", arg: ID, source: "cli" }, now),
    name: "steps" as const,
    arg: ID,
    text: "",
    source: "cli",
    created: now,
    applied_at: null,
    result: null,
  };
  const applyCtx = { db: p.db, now, subject: () => ({ title: "t", repo: "web", link: null }) };
  await applyCommand({ db: p.db, store: p.store, applyCtx, now: new Date(now * 1000) }, row);
  await p.untilStage("steps");
  for (let i = 0; i < 4; i++) await p.loop.pass();
  const after = p.mission()!;
  // Nothing was ticked, so the intent still waits for the owner.
  expect(after.stage).toBe("steps");
  expect(after.waiting).toBe("your steps");
}, 90_000);
