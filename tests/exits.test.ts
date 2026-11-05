// LOOP-76: every wait has a way out that ends or moves the intent; the owner's "I did it myself".

import { expect, test } from "vitest";
import { applyCommand, insertCommand } from "../src/commands.ts";
import { Db } from "../src/db.ts";
import type { Intent, IntentStore } from "../src/intents/types.ts";
import { apply, EXITS, exitEvent, exitsOf, finished, WAITS, wait, waitInfo } from "../src/machine.ts";
import { dataOf, insertMission, unfinishedFor } from "../src/mission.ts";
import { sendDue } from "../src/outbox.ts";
import { renderStatus } from "../src/status.ts";
import { exitsWorld } from "./helpers/exits.ts";

const text = (key: string) =>
  key === "crashed at" ? "crashed at build" : key === "bad after:" ? "bad after: 261001-0800" : key;

test("machine: every wait has an exit that ends or moves the intent", () => {
  // The table of exits and the table of waits name the same waits.
  expect(Object.keys(EXITS).sort()).toEqual(Object.keys(WAITS).sort());
  for (const key of Object.keys(WAITS)) {
    const waiting = text(key);
    const stage = waitInfo(waiting).stage;
    const moved: string[] = [];
    for (const e of exitsOf(waiting)) {
      const w = exitsWorld();
      w.set({ stage, waiting, from_stage: stage === "steps" ? null : "build", head: "abc" });
      // A plan that lists steps, so the switch to steps has somewhere to go.
      const steps = [{ n: 1, when: "after", text: "do it", why: "", done_at: null }];
      const out = w.move({ event: exitEvent(e.do as never, stage), data: { steps } });
      if (out.id !== w.m.id || out.stage !== stage || finished(out.stage)) moved.push(e.do);
      else if (stage === "steps" && out.stage !== "steps") moved.push(e.do);
    }
    expect(
      moved.length,
      `${key} has no exit that moves the intent (${exitsOf(waiting).map((e) => e.do)})`,
    ).toBeGreaterThan(0);
  }
});

test("machine: no changes can end as done", () => {
  const w = exitsWorld();
  w.set({ stage: "build" });
  w.move(wait("no changes", "nothing to change"));
  expect(w.m.stage).toBe("blocked");
  expect(exitsOf("no changes").map((e) => e.label)).toContain("Nothing to build: I did it myself");
  const out = w.move({ event: "owner_done", why: "the owner did it themselves" });
  expect(out.stage).toBe("done");
  // Any other wait ignores the event: only waits that list the exit end this way.
  const o = exitsWorld();
  o.set({ stage: "build" });
  o.move(wait("CI red"));
  expect(o.move({ event: "owner_done" }).stage).toBe("blocked");
});

const ID = "261026-1000";

function commandWorld() {
  const db = Db.memory();
  const now = 1_793_000_000;
  const updates: string[] = [];
  const store = {
    get: async () => ({ id: ID, stage: null, waiting: "no changes" }) as Intent,
    update: async (_id: string, what: string) => {
      updates.push(what);
      return {} as Intent;
    },
  } as unknown as IntentStore;
  const applyCtx = { db, now, subject: () => ({ title: "t", repo: "web", link: null }) };
  const cx = { db, store, applyCtx, now: new Date(now * 1000) };
  const mission = db.tx(() =>
    insertMission(db, { intent: ID, slug: "t", repo: "web", model: "opus", a: 3 }, now),
  );
  const run = (name: "done" | "answer", text = "") =>
    applyCommand(cx, {
      id: insertCommand(db, { name, arg: ID, text, source: "cli" }, now),
      name,
      arg: ID,
      text,
      source: "cli",
      created: now,
      applied_at: null,
      result: null,
    });
  return { db, cx, mission, run, updates, applyCtx };
}

test("cli: done ends an intent the owner did", async () => {
  const w = commandWorld();
  apply(w.applyCtx, { ...w.mission, stage: "build" } as never, wait("no changes"));
  w.db.run("UPDATE missions SET stage = 'build' WHERE id = ?", w.mission.id);
  const m0 = unfinishedFor(w.db, ID)!;
  apply(w.applyCtx, m0, wait("no changes"));
  expect(unfinishedFor(w.db, ID)?.waiting).toBe("no changes");
  expect(await w.run("done", "set it in the repo settings")).toContain("is done");
  expect(unfinishedFor(w.db, ID)).toBeUndefined();
  // At a wait without the exit it is refused and nothing moves.
  const o = commandWorld();
  o.db.run("UPDATE missions SET stage = 'build' WHERE id = ?", o.mission.id);
  apply(o.applyCtx, unfinishedFor(o.db, ID)!, wait("CI red"));
  expect(await o.run("done")).toMatch(/where "I did it myself" applies/);
  expect(unfinishedFor(o.db, ID)?.stage).toBe("blocked");
});

test("cli: done turns the note into a ticked step", async () => {
  const w = commandWorld();
  w.db.run("UPDATE missions SET stage = 'build' WHERE id = ?", w.mission.id);
  apply(w.applyCtx, unfinishedFor(w.db, ID)!, wait("no changes"));
  await w.run("done", "turned on the setting");
  const m = w.db.get<{ data: string; stage: string }>("SELECT * FROM missions WHERE id = ?", w.mission.id)!;
  const d = JSON.parse(m.data) as { steps: { text: string; done_at: string | null }[]; stepsDirty: number };
  expect(m.stage).toBe("done");
  expect(d.steps).toHaveLength(1);
  expect(d.steps[0]!.text).toBe("turned on the setting");
  expect(d.steps[0]!.done_at).toBeTruthy();
  // Written to plan.md by the loop (the mark stays until then).
  expect(d.stepsDirty).toBe(1);
  // No note: a plain sentence.
  const n = commandWorld();
  n.db.run("UPDATE missions SET stage = 'build' WHERE id = ?", n.mission.id);
  apply(n.applyCtx, unfinishedFor(n.db, ID)!, wait("no changes"));
  await n.run("done");
  const row = n.db.get<{ data: string }>("SELECT data FROM missions WHERE id = ?", n.mission.id)!;
  expect((JSON.parse(row.data) as { steps: { text: string }[] }).steps[0]!.text).toBe("Done by the owner");
});

test("outbox: the message names the exits", async () => {
  const w = exitsWorld();
  w.set({ stage: "build" });
  w.move(wait("no changes", "nothing changed"));
  const [row] = w.db.all<{ text: string }>("SELECT text FROM outbox");
  expect(row!.text.split("\n")[0]).toBe(WAITS["no changes"]!.ask);
  expect(row!.text.split("\n")[0]).toContain("say you did it yourself");
  expect(exitsOf("no changes").map((e) => e.do)).toEqual(["continue", "done", "steps", "retry", "drop"]);
  const sent: string[] = [];
  await sendDue(w.db, { send: async (t) => void sent.push(t) }, 100);
  expect(sent).toHaveLength(1);
});

test("status: waits list their exits", () => {
  const w = exitsWorld();
  w.set({ stage: "build" });
  w.move(wait("no changes", "nothing changed"));
  const render = () =>
    renderStatus({
      db: w.db,
      listing: null,
      listingError: null,
      running: 1,
      version: "1",
      now: 100,
      problems: [],
      next: "next: nothing",
      prLink: () => null,
      queued: new Set(),
    });
  expect(render()).toContain(
    "you can: Reply, Nothing to build: I did it myself, I'll do this myself: give me the steps, Start over, Drop",
  );
  expect(dataOf(w.m).stuck).toBeUndefined();
});
