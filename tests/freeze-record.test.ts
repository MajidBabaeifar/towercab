// LOOP-79's freeze record, checked on what it does: the held repo is named for the waiting mission, and
// the module has no way to reach GitHub or a program.

import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import type { Db } from "../src/db.ts";
import { freezes, frozenBy, takeFreeze } from "../src/freeze.ts";
import { insertMission } from "../src/mission.ts";
import { testDb } from "./helpers/world.ts";

const mission = (db: Db, intent: string) =>
  insertMission(db, { intent, slug: "x", repo: "web", model: "opus", a: 3 }, 0).id;

test("freeze: a refused freeze names the repo another mission holds and takes nothing", () => {
  const db = testDb();
  const a = mission(db, "261001-0900");
  const b = mission(db, "261001-1000");
  takeFreeze(db, a, ["infra"], 1);
  const r = takeFreeze(db, b, ["web", "infra"], 2);
  expect(r).toEqual({ ok: false, repo: "infra", heldBy: a });
  expect(freezes(db).map((f) => [f.repo, f.mission])).toEqual([["infra", a]]);
  expect(frozenBy(db, "web")).toBeNull();
});

test("freeze: the module imports no host, forge or process tool", () => {
  const src = readFileSync("src/freeze.ts", "utf8");
  const imports = [...src.matchAll(/^import .* from "(.*)";$/gm)].map((m) => m[1]);
  expect(imports.sort()).toEqual(["./db.ts", "./machine.ts", "./mission.ts"]);
});
