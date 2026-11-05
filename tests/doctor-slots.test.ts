// `doctor` suggests raising the limit when a run waited over 30 minutes for a slot and the machine has
// room (LOOP-104).

import { expect, test } from "vitest";
import { slotStep } from "../src/capacity.ts";
import { Db } from "../src/db.ts";
import { doctor } from "../src/doctor.ts";
import { getMission, insertMission, patchData, update } from "../src/mission.ts";
import { FakeTools } from "./helpers/tools.ts";
import { testConfig, testHome } from "./helpers/world.ts";

const now = 1_793_000_000;
const GIB = 2 ** 30;
const roomy = { cores: 16, freeBytes: 32 * GIB };

function waiting(db: Db, since: number) {
  const m = db.tx(() =>
    insertMission(db, { intent: "261026-1000", slug: "a", repo: "web", model: "opus", a: 3 }, now),
  );
  db.run("UPDATE missions SET stage = 'build', step = 'enter' WHERE id = ?", m.id);
  const b = getMission(db, m.id)!;
  patchData(db, b, { slot_wait_since: since, slot_wait_step: slotStep(b) }, now);
  return b;
}

async function slotLine(db: Db, parallel: number, at: number, capacity = roomy): Promise<string | undefined> {
  const config = testConfig({ agent: { parallel } });
  const r = await doctor({
    config,
    home: testHome(),
    tools: new FakeTools(),
    github: null,
    quick: false,
    db,
    now: at,
    capacity,
  });
  expect(r.ok).toBeTypeOf("boolean");
  return r.lines.find((l) => l.startsWith("slots: "));
}

test("doctor: suggests raising parallel after 30 minutes with room", async () => {
  const db = Db.memory();
  waiting(db, now - 31 * 60);
  expect(await slotLine(db, 1, now)).toBe(
    "slots: 261026-1000 waited 31 min for a free run; the machine has room for 4, raise [agent].parallel from 1",
  );
  // At 30 minutes or less, or with no room, there is no line.
  expect(await slotLine(db, 1, now - 120)).toBeUndefined();
  expect(await slotLine(db, 1, now, { cores: 3, freeBytes: 32 * GIB })).toBeUndefined();
});

test("doctor: the slot line disappears when the wait ends or the limit is raised", async () => {
  const db = Db.memory();
  const m = waiting(db, now - 3600);
  expect(await slotLine(db, 2, now)).toContain("raise [agent].parallel from 2");
  // The limit is raised to what the machine can carry.
  expect(await slotLine(db, 4, now)).toBeUndefined();
  // The run starts: the wait is over.
  update(db, m.id, { child_pid: 5, child_kind: "work" }, now);
  expect(await slotLine(db, 1, now)).toBeUndefined();
  // And with no mission waiting there is nothing to say.
  expect(await slotLine(Db.memory(), 1, now)).toBeUndefined();
});
