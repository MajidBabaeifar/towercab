// `status` and the overview say how many runs go against the limit, and the oldest wait for a free
// slot (LOOP-104).

import { expect, test } from "vitest";
import { slotStep } from "../src/capacity.ts";
import { Db } from "../src/db.ts";
import { getMission, insertMission, type Mission, patchData, update } from "../src/mission.ts";
import { renderStatus } from "../src/status.ts";
import { listing } from "./intents/fixtures.ts";

const now = 1_793_000_000;

function mission(db: Db, id: string, repo = "web"): Mission {
  const m = db.tx(() => insertMission(db, { intent: id, slug: id, repo, model: "opus", a: 3 }, now));
  db.run("UPDATE missions SET stage = 'build', step = 'enter' WHERE id = ?", m.id);
  return getMission(db, m.id)!;
}

const waitFor = (db: Db, m: Mission, since: number) =>
  patchData(db, m, { slot_wait_since: since, slot_wait_step: slotStep(m) }, now);

function status(db: Db, limit?: number): string {
  return renderStatus({
    db,
    listing: listing([]),
    listingError: null,
    running: 1,
    version: "1.0.0",
    now,
    problems: [],
    next: "next: nothing can run now",
    prLink: () => null,
    queued: new Set(),
    ...(limit === undefined ? {} : { limit }),
  });
}

test("status: runs going against the limit", () => {
  const db = Db.memory();
  const a = mission(db, "261026-1000");
  update(db, a.id, { child_pid: 11, child_kind: "work" }, now);
  const b = mission(db, "261026-1001", "api");
  update(db, b.id, { child_pid: 12, child_kind: "work" }, now);
  mission(db, "261026-1002", "docs");
  expect(status(db, 4)).toContain("running: 2 of 4 runs");
  // No limit given: the line is left out.
  expect(status(db)).not.toContain("running: ");
});

test("status: the oldest wait for a free slot", () => {
  const db = Db.memory();
  const holder = mission(db, "261026-1000");
  update(db, holder.id, { child_pid: 11, child_kind: "work" }, now);
  expect(status(db, 1)).not.toContain("oldest wait for a free slot");
  const young = mission(db, "261026-1001", "api");
  const old = mission(db, "261026-1002", "docs");
  waitFor(db, young, now - 120);
  waitFor(db, old, now - 2 * 3600 - 600);
  expect(status(db, 1)).toContain("oldest wait for a free slot: 261026-1002 2 h 10 min");
  // A stamp on a run that has started, or on another step, is not a wait.
  update(db, old.id, { child_pid: 13, child_kind: "work" }, now);
  expect(status(db, 1)).toContain("oldest wait for a free slot: 261026-1001 2 min");
  db.run("UPDATE missions SET step = 'later' WHERE id = ?", young.id);
  expect(status(db, 1)).not.toContain("oldest wait for a free slot");
});
