// LOOP-81: a freeze has a time limit; the owner keeps waiting, lifts it, or freezes again; after a merge
// lifting it ends the intent as merged, not verified live, and `retry` lands the rest.

import { expect, test } from "vitest";
import { applyCommand, type CommandName, insertCommand } from "../src/commands.ts";
import { freezes, frozenBy } from "../src/freeze.ts";
import type { Intent, IntentStore } from "../src/intents/types.ts";
import { apply } from "../src/machine.ts";
import { getMission, insertMission, type Mission, unfinished } from "../src/mission.ts";
import { PartDriver } from "../src/partloop.ts";
import { applyPart } from "../src/partrun.ts";
import { currentPart, partsOf } from "../src/parts.ts";
import { TestClock, testDb } from "./helpers/world.ts";

const ID = "261026-1000";
const PLAN = { parts: ["infra", "web"], waitsOn: { infra: [], web: ["infra"] } };
const MIN = 60;

/** A mission with both parts at the gate and a driver on a test clock; one pass takes the freeze. */
async function world() {
  const db = testDb();
  const clock = new TestClock();
  const subject = (m: Mission) => ({ title: "Show a greeting", repo: m.repo, link: null });
  const cx = () => ({ db, now: clock.now(), subject });
  let m = db.tx(() =>
    insertMission(db, { intent: ID, slug: "greet", repo: "web", model: "opus", a: 5 }, clock.now()),
  );
  m = apply(cx(), m, { event: "ok" });
  m = apply(cx(), m, { event: "ok" });
  m = apply(cx(), m, { event: "wait", waiting: "approve plan", data: { plan: PLAN } });
  m = apply(cx(), m, { event: "plan_merged" });
  for (const repo of PLAN.parts)
    for (let i = 0; i < 7; i++) applyPart(cx(), getMission(db, m.id)!, repo, { event: "ok" });
  const driver = new PartDriver({
    db,
    config: { agent: { freezeWaitMin: 120, maxBudgetUsd: 10, parallel: 4 }, repos: new Map() } as never,
    clock,
    handlers: {},
    log: () => {},
    ctx: () => {
      throw new Error("no handler runs here");
    },
    applyCtx: cx,
    lock: (fn) => fn(),
    unfinished: () => unfinished(db),
    holding: () => false,
    slotsUsed: () => 0,
  });
  const store = { get: async () => ({ id: ID, stage: null }) as Intent } as unknown as IntentStore;
  const run = (name: CommandName) =>
    applyCommand(
      { db, store, applyCtx: cx(), now: new Date(clock.now() * 1000) },
      {
        id: insertCommand(db, { name, arg: ID, source: "cli" }, clock.now()),
        name,
        arg: ID,
        text: "",
        source: "cli",
        created: clock.now(),
        applied_at: null,
        result: null,
      },
    );
  const now = () => getMission(db, m.id)!;
  const pass = () => driver.pass(false);
  await pass();
  expect(frozenBy(db, "web")).toBe(m.id);
  return { db, clock, cx, run, now, pass, id: m.id };
}

/** The freeze is a long way past the limit: the mission asks. */
const asked = async (w: Awaited<ReturnType<typeof world>>) => {
  w.clock.advance(121 * MIN);
  await w.pass();
};

test("loop: a freeze past the limit asks the owner", async () => {
  const w = await world();
  w.clock.advance(119 * MIN);
  await w.pass();
  expect(w.now().stage).toBe("merge");
  w.clock.advance(2 * MIN);
  await w.pass();
  expect(w.now().stage).toBe("blocked");
  expect(w.now().waiting).toBe("freeze");
  expect(w.now().why).toContain("infra: not merged");
  // The freeze holds while the owner decides.
  expect(frozenBy(w.db, "infra")).toBe(w.id);
});

test("loop: continue keeps waiting another period", async () => {
  const w = await world();
  await asked(w);
  apply(w.cx(), w.now(), { event: "answered" });
  expect(w.now().stage).toBe("merge");
  w.clock.advance(100 * MIN);
  await w.pass();
  expect(w.now().stage).toBe("merge");
  w.clock.advance(21 * MIN);
  await w.pass();
  expect(w.now().waiting).toBe("freeze");
});

test("loop: unfreeze before any merge waits for the owner's go-ahead", async () => {
  const w = await world();
  await asked(w);
  expect(await w.run("unfreeze")).toBe(`unfroze ${ID} (infra, web)`);
  expect(w.now().waiting).toBe("freeze lifted");
  expect(freezes(w.db)).toEqual([]);
  // Nothing merges and nothing freezes while the owner has not said so.
  w.clock.advance(300 * MIN);
  await w.pass();
  expect(w.now().waiting).toBe("freeze lifted");
  expect(partsOf(w.now()).some((p) => p.merged)).toBe(false);
});

test("loop: a lifted freeze is never taken again on its own", async () => {
  const w = await world();
  await asked(w);
  await w.run("unfreeze");
  for (let i = 0; i < 5; i++) {
    w.clock.advance(61);
    await w.pass();
  }
  expect(freezes(w.db)).toEqual([]);
  expect(w.now().stage).toBe("blocked");
});

test("loop: freeze again takes the freeze", async () => {
  const w = await world();
  await asked(w);
  await w.run("unfreeze");
  apply(w.cx(), w.now(), { event: "answered" });
  expect(w.now().stage).toBe("merge");
  await w.pass();
  expect(frozenBy(w.db, "web")).toBe(w.id);
  expect(frozenBy(w.db, "infra")).toBe(w.id);
});

/** `infra` merged, then the limit passed, then the owner lifted the freeze. */
async function afterMerge() {
  const w = await world();
  applyPart(w.cx(), w.now(), "infra", { event: "code_merged", set: { merge_sha: "sha-infra" } });
  await asked(w);
  const said = await w.run("unfreeze");
  return { w, said };
}

test("loop: unfreeze after a merge ends unverified and rolls nothing back", async () => {
  const { w, said } = await afterMerge();
  expect(said).toContain("merged, not verified live");
  expect(w.now().stage).toBe("unverified");
  expect(freezes(w.db)).toEqual([]);
  // Nothing was rolled back: the merged part stays merged.
  expect(partsOf(w.now()).map((p) => [p.repo, p.merged, p.stage])).toEqual([
    ["infra", true, "gate"],
    ["web", false, "gate"],
  ]);
});

test("loop: the unverified card lists merged and unmerged parts", async () => {
  const { w } = await afterMerge();
  const notes = w.db.all<{ text: string }>("SELECT text FROM outbox WHERE key LIKE 'unverified:%'");
  expect(notes).toHaveLength(1);
  expect(notes[0]!.text).toContain("Merged: infra. Not merged: web.");
  expect(notes[0]!.text).toContain("retry");
  expect(w.now().why).toContain("Merged: infra. Not merged: web.");
});

test("loop: retry lands only the unmerged parts", async () => {
  const { w } = await afterMerge();
  expect(await w.run("retry")).toContain("landing the rest");
  expect(w.now().stage).toBe("ci");
  // The merged part is left alone; the other passes its checks again, then lands under a new freeze.
  expect(partsOf(w.now()).map((p) => [p.repo, p.atGate, p.merged])).toEqual([
    ["infra", true, true],
    ["web", false, false],
  ]);
  for (let i = 0; i < 3; i++) applyPart(w.cx(), w.now(), "web", { event: "ok" });
  expect(w.now().stage).toBe("merge");
  await w.pass();
  expect(frozenBy(w.db, "web")).toBe(w.id);
  expect(currentPart(w.now(), partsOf(w.now()))?.repo).toBe("web");
});
