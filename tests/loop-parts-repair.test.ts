// LOOP-78: a reply at the budget wait lets the parts run again; a lost session is replaced on its part.

import { expect, test } from "vitest";
import { apply } from "../src/machine.ts";
import { getMission, insertMission, type Mission, update } from "../src/mission.ts";
import { applyPart, project, stopForCap } from "../src/partrun.ts";
import { capReached, partsOf } from "../src/parts.ts";
import { resetSession } from "../src/pipeline/common.ts";
import { testDb } from "./helpers/world.ts";

function building() {
  const db = testDb();
  const cx = { db, now: 10, subject: (m: Mission) => ({ title: "t", repo: m.repo, link: null }) };
  let m = db.tx(() =>
    insertMission(db, { intent: "261026-1000", slug: "g", repo: "web", model: "opus", a: 5 }, 1),
  );
  m = apply(cx, m, { event: "ok" });
  m = apply(cx, m, { event: "ok" });
  m = apply(cx, m, {
    event: "wait",
    waiting: "approve plan",
    data: { plan: { parts: ["infra", "web"], waitsOn: { infra: [], web: ["infra"] } } },
  });
  m = apply(cx, m, { event: "plan_merged" });
  return { db, cx, id: m.id };
}

test("loop: a reply at the budget wait lets the parts carry on", () => {
  const { db, cx, id } = building();
  update(db, id, { cost_usd: 10 }, 1);
  expect(capReached(10, getMission(db, id)!)).toBe(true);
  stopForCap(cx, getMission(db, id)!, "used up");
  expect(getMission(db, id)!.waiting).toBe("worker budget");
  apply(cx, getMission(db, id)!, { event: "answered" });
  const m = getMission(db, id)!;
  expect(m.stage).toBe("build");
  expect(capReached(10, m)).toBe(false);
  // The cap counts again from here.
  update(db, id, { cost_usd: 20 }, 1);
  expect(capReached(10, getMission(db, id)!)).toBe(true);
  void applyPart;
});

test("loop: a lost session is replaced on its part", () => {
  const { db, id } = building();
  const m = getMission(db, id)!;
  const part = partsOf(m)[0]!;
  const old = part.cols!.session;
  resetSession({ db } as never, project(m, part));
  const fresh = partsOf(getMission(db, id)!)[0]!;
  expect(fresh.cols!.session).not.toBe(old);
  expect(fresh.cols!.session_used).toBe(0);
  expect(partsOf(getMission(db, id)!)[1]!.cols!.session).toBe(partsOf(m)[1]!.cols!.session);
});
