import { expect, test } from "vitest";
import { intentPaused } from "../src/commands.ts";
import { Db } from "../src/db.ts";
import { apply } from "../src/machine.ts";
import { insertMission, type Mission } from "../src/mission.ts";
import { clearRoute, endTurnWait, nextTurns, waitsTurn } from "../src/route.ts";

const NOW = 1_793_000_000;

/** A mission taken `oks` steps along its way (3 = build, 7 = ci). */
function mission(db: Db, id: string, oks: number, repo = "web"): Mission {
  const cx = { db, now: NOW, subject: () => ({ title: "t", repo, link: null }) };
  let m = db.tx(() => insertMission(db, { intent: id, slug: "x", repo, model: "opus", a: 3 }, NOW));
  for (let i = 0; i < oks; i++) m = apply(cx, m, { event: "ok" });
  return m;
}

test("route: clearing the route pauses every intent past its plan", () => {
  const db = Db.memory();
  mission(db, "a", 3);
  mission(db, "b", 7);
  mission(db, "c", 1);
  mission(db, "d", 3, "api");
  expect(clearRoute(db, "web", NOW).sort()).toEqual(["a", "b"]);
  expect(intentPaused(db, "a") && waitsTurn(db, "a")).toBe(true);
  expect(intentPaused(db, "c")).toBe(false);
  expect(intentPaused(db, "d")).toBe(false);
  expect(clearRoute(db, null, NOW)).toEqual(["d"]);
});

test("route: one intent per repo resumes, the furthest first, where it stopped", () => {
  const db = Db.memory();
  mission(db, "a", 3);
  mission(db, "b", 7);
  mission(db, "c", 3, "api");
  clearRoute(db, null, NOW);
  expect(nextTurns(db, () => 0).sort()).toEqual(["b", "c"]);
  expect(intentPaused(db, "b")).toBe(false);
  expect(waitsTurn(db, "a")).toBe(true);
  // b still goes: a waits.
  expect(nextTurns(db, () => 0)).toEqual([]);
  db.run("UPDATE missions SET stage = 'done' WHERE intent = 'b'");
  expect(nextTurns(db, () => 0)).toEqual(["a"]);
  expect(db.get<Mission>("SELECT * FROM missions WHERE intent = 'a'")!.stage).toBe("build");
});

test("route: the owner's resume ends the wait for a turn", () => {
  const db = Db.memory();
  mission(db, "a", 3);
  clearRoute(db, null, NOW);
  db.delMeta("paused:a");
  endTurnWait(db, "a");
  expect(waitsTurn(db, "a")).toBe(false);
});
