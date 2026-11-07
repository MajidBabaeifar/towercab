// LOOP-79's freeze record: all repos or none, kept in the database, never written to GitHub.

import { expect, test } from "vitest";
import type { Db } from "../src/db.ts";
import { freezeAge, frozenBy, liftFreeze, takeFreeze } from "../src/freeze.ts";
import { insertMission } from "../src/mission.ts";
import { testDb } from "./helpers/world.ts";

const mission = (db: Db, intent: string) =>
  insertMission(db, { intent, slug: "x", repo: "web", model: "opus", a: 3 }, 0).id;

test("loop: all the repos freeze in one step or none", () => {
  const db = testDb();
  const a = mission(db, "261001-0900");
  const b = mission(db, "261001-1000");
  expect(takeFreeze(db, a, ["infra"], 10)).toEqual({ ok: true });
  const r = takeFreeze(db, b, ["web", "infra"], 20);
  expect(r).toEqual({ ok: false, repo: "infra", heldBy: a });
  expect(frozenBy(db, "web")).toBeNull();
  expect(takeFreeze(db, a, ["web", "infra"], 30)).toEqual({ ok: true });
  expect(frozenBy(db, "web")).toBe(a);
  // Taking it again keeps the first time.
  expect(freezeAge(db, a, 40)).toBe(30);
  expect(liftFreeze(db, a).sort()).toEqual(["infra", "web"]);
  expect(frozenBy(db, "infra")).toBeNull();
});

test("loop: a held freeze makes the mission wait at the gate", () => {
  const db = testDb();
  const a = mission(db, "261001-0900");
  const b = mission(db, "261001-1000");
  takeFreeze(db, a, ["web"], 1);
  const r = takeFreeze(db, b, ["web"], 2);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(`waiting for the freeze of ${r.repo}`).toBe("waiting for the freeze of web");
});

test("loop: a freeze survives a restart", () => {
  const db = testDb();
  const a = mission(db, "261001-0900");
  takeFreeze(db, a, ["web", "infra"], 5);
  // The freeze is rows of the database, read fresh each time: no memory of the process holds it.
  expect(frozenBy(db, "web")).toBe(a);
  expect(frozenBy(db, "infra")).toBe(a);
  expect(freezeAge(db, a, 65)).toBe(60);
});

test("loop: a freeze writes nothing to GitHub", () => {
  const db = testDb();
  const a = mission(db, "261001-0900");
  // The module takes a database and no host: it has no way to reach GitHub.
  expect(takeFreeze.length).toBe(4);
  expect(takeFreeze(db, a, ["web"], 1).ok).toBe(true);
});

test("freeze: a freeze of a finished mission counts as lifted", () => {
  const db = testDb();
  const a = mission(db, "261001-0900");
  takeFreeze(db, a, ["web"], 1);
  db.run("UPDATE missions SET stage = 'done' WHERE id = ?", a);
  expect(frozenBy(db, "web")).toBeNull();
});
