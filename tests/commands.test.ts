// The start command (LOOP-63): refused for an intent that already started.

import { expect, test } from "vitest";
import { applyCommand, insertCommand } from "../src/commands.ts";
import { Db } from "../src/db.ts";
import type { Intent, IntentStore } from "../src/intents/types.ts";
import { apply } from "../src/machine.ts";
import { insertMission } from "../src/mission.ts";

const ID = "261026-1000";

test("commands: start is refused for a started intent", async () => {
  const db = Db.memory();
  const now = 1_793_000_000;
  const store = { get: async () => ({ id: ID, stage: null }) as Intent } as unknown as IntentStore;
  const applyCtx = { db, now, subject: () => ({ title: "t", repo: "web", link: null }) };
  const cx = { db, store, applyCtx, now: new Date(now * 1000) };
  const start = () =>
    applyCommand(cx, {
      id: insertCommand(db, { name: "start", arg: ID, source: "cli" }, now),
      name: "start",
      arg: ID,
      text: "",
      source: "cli",
      created: now,
      applied_at: null,
      result: null,
    });

  expect(await start()).toMatch(`starting ${ID}`);
  expect(db.meta(`start:${ID}`)).toBe("1");
  expect(await start()).toBe(`start: ${ID} has already started`);
  // With a mission running, a fresh marker doesn't help either.
  db.delMeta(`start:${ID}`);
  const m = db.tx(() => insertMission(db, { intent: ID, slug: "t", repo: "web", model: "opus", a: 3 }, now));
  expect(await start()).toBe(`start: ${ID} has already started`);
  apply(applyCtx, m, { event: "intent_removed" });
  // A dropped intent is refused too.
  const dropped = { get: async () => ({ id: ID, stage: "dropped" }) as Intent } as unknown as IntentStore;
  const r = await applyCommand(
    { ...cx, store: dropped },
    { id: 99, name: "start", arg: ID, text: "", source: "cli", created: now, applied_at: null, result: null },
  );
  expect(r).toBe(`start: ${ID} is done or dropped`);
});
