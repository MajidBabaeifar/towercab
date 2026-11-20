// The merge queue of a repo (LOOP-159..162), pure.

import { expect, test } from "vitest";
import { type ApplyCtx, apply, type Stage } from "../src/machine.ts";
import { dataOf, getMission, insertMission, type Mission } from "../src/mission.ts";
import { conflictHeld, headOf, queueOf, queuePlace } from "../src/queue.ts";
import { isIdle } from "../src/slots.ts";
import { testDb } from "./helpers/world.ts";

let next = 1;
function mission(stage: Stage, data: Record<string, unknown> = {}, repo = "web"): Mission {
  const id = next++;
  return {
    id,
    intent: `261001-09${String(id).padStart(2, "0")}`,
    repo,
    stage,
    from_stage: null,
    waiting: null,
    merge_sha: null,
    updated: 0,
    data: JSON.stringify(data),
  } as unknown as Mission;
}

test("queue: missions land first in first out", () => {
  const a = mission("merge", { queuedAt: 30 });
  const b = mission("merge", { queuedAt: 10 });
  const c = mission("merge", { queuedAt: 20 });
  const other = mission("merge", { queuedAt: 1 }, "api");
  const ms = [a, b, c, other, mission("review")];
  expect(queueOf(ms, "web").map((m) => m.id)).toEqual([b.id, c.id, a.id]);
  expect(headOf(ms, "web")?.id).toBe(b.id);
  expect(queuePlace(ms, a)).toEqual({ n: 3, of: 3 });
  expect(headOf([], "web")).toBeNull();
});

test("queue: the landing mission stays head", () => {
  // Back at build for a conflict round, the head keeps its turn.
  const head = mission("build", { queuedAt: 50, landing: { since: 60 } });
  const early = mission("merge", { queuedAt: 10 });
  expect(headOf([early, head], "web")?.id).toBe(head.id);
  expect(headOf([early, mission("done", { landing: { since: 1 } })], "web")?.id).toBe(early.id);
});

test("queue: a conflict waits unless the mission is head", () => {
  const head = mission("merge", { queuedAt: 10, landing: { since: 11 } });
  const second = mission("merge", { queuedAt: 20 });
  const approval = mission("approval:merge");
  const ci = mission("ci");
  const ms = [head, second, approval, ci];
  expect(conflictHeld(ms, head)).toBe(false);
  expect(conflictHeld(ms, second)).toBe(true);
  expect(conflictHeld(ms, approval)).toBe(true);
  expect(conflictHeld(ms, ci)).toBe(false);
  expect(conflictHeld([second, approval], approval)).toBe(false);
});

test("slots: a mission queued to merge is idle", () => {
  expect(isIdle(mission("merge", { queuedAt: 1 }))).toBe(true);
  expect(isIdle(mission("merge", { queuedAt: 1, landing: { since: 2 } }))).toBe(false);
});

function moved(stage: Stage, data: Record<string, unknown>) {
  const db = testDb();
  const m0 = insertMission(db, { intent: "261001-0900", slug: "x", repo: "web", model: "opus", a: 3 }, 0);
  db.run(
    "UPDATE missions SET stage = ?, step = '', data = ? WHERE id = ?",
    stage,
    JSON.stringify(data),
    m0.id,
  );
  const cx: ApplyCtx = { db, now: 100, subject: () => ({ title: "X", repo: "web", link: null }) };
  return { cx, m: getMission(db, m0.id)! };
}

test("queue: entering merge stamps the time", () => {
  const { cx, m } = moved("gate", {});
  const at = apply(cx, m, { event: "ok" });
  expect(at.stage).toBe("merge");
  expect(dataOf<{ queuedAt?: number }>(at).queuedAt).toBe(100);
  // A head back from a conflict round keeps its place.
  const back = moved("gate", { queuedAt: 5, landing: { since: 6 } });
  expect(dataOf(apply(back.cx, back.m, { event: "ok" }))).toMatchObject({
    queuedAt: 5,
    landing: { since: 6 },
  });
});

test("queue: a wait leaves the queue", () => {
  const { cx, m } = moved("merge", { queuedAt: 5, landing: { since: 6 } });
  const w = apply(cx, m, { event: "wait", waiting: "merge failed", why: "still conflicts" });
  expect(w.stage).not.toBe("merge");
  const d = dataOf<{ queuedAt?: number; landing?: unknown }>(w);
  expect(d.queuedAt).toBeUndefined();
  expect(d.landing).toBeUndefined();
});
