// LOOP-81: the unfreeze command lifts the intent's freeze and waits for the owner before freezing again.

import { expect, test } from "vitest";
import { applyCommand, type CommandName, insertCommand } from "../src/commands.ts";
import { Db } from "../src/db.ts";
import { frozenBy, takeFreeze } from "../src/freeze.ts";
import type { Intent, IntentStore } from "../src/intents/types.ts";
import { exitsOf, WAITS, wait } from "../src/machine.ts";
import { getMission, insertMission } from "../src/mission.ts";

const ID = "261026-1000";
const now = 1_793_000_000;

function world() {
  const db = Db.memory();
  const store = { get: async () => ({ id: ID, stage: null }) as Intent } as unknown as IntentStore;
  const applyCtx = { db, now, subject: () => ({ title: "t", repo: "web", link: null }) };
  const cx = { db, store, applyCtx, now: new Date(now * 1000) };
  const m = db.tx(() => insertMission(db, { intent: ID, slug: "t", repo: "web", model: "opus", a: 3 }, now));
  const run = (name: CommandName) =>
    applyCommand(cx, {
      id: insertCommand(db, { name, arg: ID, source: "cli" }, now),
      name,
      arg: ID,
      text: "",
      source: "cli",
      created: now,
      applied_at: null,
      result: null,
    });
  return { db, m, run };
}

test("cli: unfreeze lifts the freeze", async () => {
  const { db, m, run } = world();
  takeFreeze(db, m.id, ["web", "infra"], now);
  db.run(
    "UPDATE missions SET stage = 'blocked', waiting = 'freeze', from_stage = 'merge' WHERE id = ?",
    m.id,
  );
  expect(await run("unfreeze")).toBe(`unfroze ${ID} (infra, web)`);
  expect(frozenBy(db, "web")).toBeNull();
  expect(frozenBy(db, "infra")).toBeNull();
  // Nothing freezes again on its own: the mission waits for the owner's click.
  const cur = getMission(db, m.id)!;
  expect(cur.stage).toBe("blocked");
  expect(cur.waiting).toBe("freeze lifted");
  expect(frozenBy(db, "web")).toBeNull();
});

test("cli: unfreeze is refused where there is no freeze wait", async () => {
  const { run } = world();
  expect(await run("unfreeze")).toMatch(/isn't at a freeze that can be lifted/);
});

test("machine: the freeze waits offer keep waiting, lift and drop, and freezing again", () => {
  expect(exitsOf("freeze").map((e) => e.do)).toEqual(["continue", "unfreeze", "drop"]);
  expect(exitsOf("freeze lifted").map((e) => e.do)).toEqual(["continue", "drop"]);
  expect(WAITS["freeze lifted"]!.stage).toBe("blocked");
  expect(wait("freeze", "x").waiting).toBe("freeze");
});
