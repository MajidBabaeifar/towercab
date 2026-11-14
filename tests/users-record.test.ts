import { expect, test } from "vitest";
import { runAs } from "../src/actor.ts";
import { insertCommand, pendingCommands } from "../src/commands.ts";
import { apply } from "../src/machine.ts";
import { insertMission } from "../src/mission.ts";
import { testDb } from "./helpers/world.ts";

const ana = { login: "ana", name: "Ana", role: "maintainer" as const, via: "telegram" as const };

test("users: a transition records who moved it and through which channel", () => {
  const db = testDb();
  const m = db.tx(() =>
    insertMission(db, { intent: "261026-1000", slug: "x", repo: "web", model: "opus", a: 3 }, 1),
  );
  const cx = { db, now: 10, subject: () => ({ title: "x", repo: "web", link: null }) };
  const next = runAs(ana, () => apply(cx, m, { event: "ok" }));
  apply(cx, next, { event: "ok" });
  const rows = db.all<{ actor: string; via: string }>("SELECT actor, via FROM transitions ORDER BY id");
  expect(rows).toEqual([
    { actor: "ana", via: "telegram" },
    { actor: "towercab", via: "" },
  ]);
});

test("users: a command keeps who queued it and runs as them", () => {
  const db = testDb();
  insertCommand(db, { name: "pause", source: "cli", actor: "owner" }, 1);
  runAs(ana, () => insertCommand(db, { name: "resume", source: "ui" }, 2));
  insertCommand(db, { name: "pause", source: "cli" }, 3);
  expect(db.all("SELECT actor, via FROM commands ORDER BY id")).toEqual([
    { actor: "owner", via: "cli" },
    { actor: "ana", via: "telegram" },
    { actor: "towercab", via: "" },
  ]);
  expect(pendingCommands(db).length).toBe(3);
});
