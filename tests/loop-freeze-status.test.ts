// LOOP-79: `towercab status` says which repos are frozen and by which intent.

import { expect, test } from "vitest";
import { Db } from "../src/db.ts";
import { liftFreeze, takeFreeze } from "../src/freeze.ts";
import { insertMission } from "../src/mission.ts";
import { renderStatus } from "../src/status.ts";

test("status: lists the frozen repos and the intent that froze them", () => {
  const db = Db.memory();
  const now = 1_793_000_000;
  const m = db.tx(() =>
    insertMission(db, { intent: "261026-1000", slug: "a", repo: "web", model: "opus", a: 3 }, now),
  );
  takeFreeze(db, m.id, ["infra", "web"], now);
  const input = {
    db,
    listing: null,
    listingError: null,
    running: 1,
    version: "1.0.0",
    now,
    problems: [],
    next: "next: nothing open",
    prLink: () => null,
    queued: new Set<number>(),
  };
  const text = renderStatus(input);
  expect(text).toContain("frozen: infra by 261026-1000");
  expect(text).toContain("frozen: web by 261026-1000");
  liftFreeze(db, m.id);
  expect(renderStatus(input)).not.toContain("frozen:");
});
