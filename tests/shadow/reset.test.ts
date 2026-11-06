// SHD-17, SHD-18, SHD-9: a reset keeps the log and the cost and never lets a new message meet an old turn's actions.

import { expect, test } from "vitest";
import { pendingActions } from "../../src/shadow/store.ts";
import { spend } from "../../src/ui/state.ts";
import { Rig } from "./rig.ts";

const merge = { action: "merge", intent: "i-1", repo: "", title: "", text: "" };

test("shadow: a message after a reset is not answered with an old turn's actions", async () => {
  const r = new Rig();
  r.mission("i-1", "approval:merge", "review and merge PR");
  r.say("merge i-1");
  r.child({ reply: "Asking.", actions: [merge] }, 0.3);
  const sh = r.shadow();
  await r.run(sh);
  expect(pendingActions(r.db)).toHaveLength(1);
  r.say("/reset");
  await r.run(sh);
  // The next turn gets turn number 1 again; the old action row must not belong to it.
  r.say("what is going on?");
  r.child({ reply: "Nothing much." }, 0.1);
  await r.run(sh);
  expect(r.outbox().at(-1)).toBe("[shadow] Nothing much.");
  expect(r.tools.spawned).toHaveLength(2);
  expect(pendingActions(r.db)).toEqual([]);
  // A plain yes now has nothing to approve.
  r.say("yes");
  await r.run(sh);
  expect(r.calls).toEqual([]);
});

test("shadow: a reset keeps today's cost in the cap and the spend", async () => {
  const r = new Rig({ daily_budget_usd: 0.5 });
  r.say("hello");
  r.child({ reply: "hi" }, 0.6);
  const sh = r.shadow();
  await r.run(sh);
  r.say("/reset");
  await r.run(sh);
  expect(spend(r.db, r.clock.now()).today).toBeCloseTo(0.6);
  // The cap still holds after the reset.
  r.say("again");
  await r.run(sh);
  expect(r.tools.spawned).toHaveLength(1);
  expect(r.outbox().at(-1)).toContain("today's cap");
});

test("shadow: a free merge still asks for a spec or a plan", async () => {
  const r = new Rig({ free: ["merge"] });
  r.mission("i-1", "approval:plan", "approve plan");
  const line = await r.exec().request(1, 0, { ...merge });
  expect(line).toBe("Merge i-1? Reply yes or no.");
  expect(r.calls).toEqual([]);
});
