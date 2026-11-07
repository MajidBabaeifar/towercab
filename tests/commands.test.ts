// The start command (LOOP-63): refused for an intent that already started.

import { expect, test } from "vitest";
import {
  applyCommand,
  type CommandName,
  ignoredNotes,
  insertCommand,
  intentPaused,
  paused,
} from "../src/commands.ts";
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

const row = (id: number, name: CommandName, arg: string, source: string, text = "") => ({
  id,
  name,
  arg,
  text,
  source,
  created: 0,
  applied_at: null,
  result: null,
});

function a0World(a: number | null) {
  const db = Db.memory();
  const now = 1_793_000_000;
  const store = {
    get: async () => ({ id: ID, stage: null, a, waiting: null }) as unknown as Intent,
  } as unknown as IntentStore;
  const applyCtx = { db, now, subject: () => ({ title: "t", repo: "web", link: null }) };
  return { db, now, cx: { db, store, applyCtx, now: new Date(now * 1000) } };
}

test("commands: an a0 command row from the cli is dropped", async () => {
  const { db, cx } = a0World(0);
  for (const [n, name] of (["start", "drop", "answer", "retry", "done", "steps"] as const).entries()) {
    const r = await applyCommand(cx, row(10 + n, name, ID, "cli", "hi"));
    expect(r).toBe(`${name}: ${ID} is only yours: use GitHub or the page`);
  }
  // Nothing happened: no start marker, and the drop did not touch the intent.
  expect(db.meta(`start:${ID}`)).toBeNull();
  // The drop is noted on the intent once per row.
  expect(ignoredNotes(db, ID).length).toBeGreaterThan(0);
  expect(ignoredNotes(db, ID).some((n) => n.text.includes('"drop" from the cli'))).toBe(true);
  // The page counts as the owner.
  expect(await applyCommand(cx, row(2, "start", ID, "ui"))).toMatch(`starting ${ID}`);
  // Another intent is not affected.
  const other = a0World(4);
  expect(await applyCommand(other.cx, row(3, "start", ID, "cli"))).toMatch(`starting ${ID}`);
});

test("commands: pause and resume take one intent", async () => {
  const { db, cx } = a0World(0);
  // A pause is allowed from anywhere, on an a0 intent too; only that intent is paused.
  expect(await applyCommand(cx, row(1, "pause", ID, "cli"))).toMatch(`paused ${ID}`);
  expect(intentPaused(db, ID)).toBe(true);
  expect(paused(db)).toBe(false);
  // The cli can't resume an a0 intent; the page can.
  expect(await applyCommand(cx, row(2, "resume", ID, "cli"))).toBe(
    `resume: ${ID} is only yours: use GitHub or the page`,
  );
  expect(intentPaused(db, ID)).toBe(true);
  expect(await applyCommand(cx, row(3, "resume", ID, "ui"))).toBe(`resumed ${ID}`);
  expect(intentPaused(db, ID)).toBe(false);
  // The global pause still works.
  expect(await applyCommand(cx, row(4, "pause", "", "cli"))).toMatch(/^paused: nothing new starts/);
  expect(paused(db)).toBe(true);
});
