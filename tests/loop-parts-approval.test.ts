// LOOP-80: the owner's yes holds for one landing; a part's own wait for a teammate doesn't take the mission.

import { expect, test } from "vitest";
import { apply } from "../src/machine.ts";
import { dataOf, getMission, insertMission, type Mission } from "../src/mission.ts";
import { applyPart } from "../src/partrun.ts";
import { partsOf } from "../src/parts.ts";
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

test("loop: a rollback clears the owner's approval of the landing", () => {
  const { db, cx, id } = building();
  for (const repo of ["infra", "web"])
    for (let i = 0; i < 7; i++) applyPart(cx, getMission(db, id)!, repo, { event: "ok" });
  for (const repo of ["infra", "web"])
    applyPart(cx, getMission(db, id)!, repo, { event: "code_merged", set: { merge_sha: `sha-${repo}` } });
  const d = dataOf(getMission(db, id)!);
  db.run(
    "UPDATE missions SET data = ? WHERE id = ?",
    JSON.stringify({ ...d, landApproved: true, ownerApproved: true }),
    id,
  );
  applyPart(cx, getMission(db, id)!, "infra", { event: "red", why: "e2e failed" });
  for (const repo of ["web", "infra"]) applyPart(cx, getMission(db, id)!, repo, { event: "ok" });
  const m = getMission(db, id)!;
  expect(m.stage).toBe("build");
  expect(dataOf<{ landApproved?: boolean; ownerApproved?: boolean }>(m)).toMatchObject({});
  expect(dataOf<{ landApproved?: boolean }>(m).landApproved).toBeUndefined();
  expect(dataOf<{ ownerApproved?: boolean }>(m).ownerApproved).toBeUndefined();
});

test("loop: a part waiting for a teammate doesn't take the mission to the owner's approval", () => {
  const { db, cx, id } = building();
  for (let i = 0; i < 6; i++) applyPart(cx, getMission(db, id)!, "infra", { event: "ok" });
  const m = applyPart(cx, getMission(db, id)!, "infra", {
    event: "wait",
    waiting: "teammate review",
    why: "waiting for them",
  });
  expect(m.stage).toBe("build");
  expect(partsOf(m)[0]!.waiting).toBeNull();
  // The other part goes on.
  expect(partsOf(applyPart(cx, m, "web", { event: "ok" }))[1]!.stage).toBe("verify");
});
