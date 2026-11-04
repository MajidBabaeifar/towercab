// UI-160..163: the owner's steps and the unverified end on the page, the map, the airspace and the board.

import { afterEach, expect, test } from "vitest";
import { tickSteps } from "../../src/commands.ts";
import type { Stage } from "../../src/machine.ts";
import { createActions } from "../../src/ui/actions.ts";
import { board } from "../../src/ui/board.ts";
import { startUi } from "../../src/ui/server.ts";
import { finishedState, intentPage, shipWords, stageMap, stateOf, stationOf } from "../../src/ui/state.ts";
import { buildFixture, type Fixture, IDS } from "../../ui/fixture.ts";
import { TestClock, testConfig } from "../helpers/world.ts";
import { post } from "./http.ts";

// Mon 26 Oct 2026, 23:00:00 local time.
const NOW = new Date(2026, 9, 26, 23, 0, 0).getTime() / 1000;
const open: (() => unknown)[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
});
function fixture(): Fixture {
  const f = buildFixture({ now: NOW });
  open.push(() => f.cleanup());
  return f;
}

const STEPS = [
  { n: 1, when: "before", text: "add the secret", why: "the release needs it", done_at: null },
  {
    n: 2,
    when: "after",
    text: "run the apply",
    why: "the server needs it",
    done_at: "2026-10-26T22:30:00+00:00",
  },
  { n: 3, when: "after", text: "enable the setting", why: "the feature is off", done_at: null },
];

function setMission(f: Fixture, intent: string, set: string, data: Record<string, unknown>) {
  f.db.run(
    `UPDATE missions SET ${set}, data = ? WHERE id = (SELECT MAX(id) FROM missions WHERE intent = ?)`,
    JSON.stringify(data),
    intent,
  );
}

test("ui: your steps checklist", async () => {
  const f = fixture();
  setMission(f, IDS.code, "stage = 'steps', step = '', waiting = 'your steps'", { steps: STEPS });
  const page = (await intentPage(f.sources, IDS.code))!;
  // Before-merge steps first, then after-merge ones, each with its text, why and when it was ticked.
  expect(page.steps!.map((s) => [s.n, s.when, s.text, s.doneAt !== null])).toEqual([
    [1, "before", "add the secret", false],
    [2, "after", "run the apply", true],
    [3, "after", "enable the setting", false],
  ]);
  expect(page.steps![1]!.why).toBe("the server needs it");
  expect(page.steps![1]!.doneAt!.exact).toBeTruthy();
  // The block is highlighted while the mission waits on the steps after the merge.
  expect(page.stepsWait).toBe("after");
  expect(page.state).toMatchObject({ key: "needs", note: "Your steps" });
  // At the hold before the merge it waits on the first ones.
  setMission(f, IDS.code, "stage = 'blocked', from_stage = 'gate', waiting = 'your steps first'", {
    steps: STEPS,
  });
  expect((await intentPage(f.sources, IDS.code))!.stepsWait).toBe("before");
  // Not waiting on them: shown, not highlighted. A plan without steps has no block.
  setMission(f, IDS.code, "stage = 'build', waiting = NULL, from_stage = NULL", { steps: STEPS });
  expect((await intentPage(f.sources, IDS.code))!.stepsWait).toBeNull();
  setMission(f, IDS.code, "stage = 'build'", {});
  expect((await intentPage(f.sources, IDS.code))!.steps).toBeUndefined();
});

test("ui: ticking a step posts the action", async () => {
  const f = fixture();
  const ui = startUi({
    port: 0,
    sources: f.sources,
    actions: f.actions,
    distDir: "/nonexistent",
    log: () => {},
    pollMs: 20,
  });
  open.push(() => ui.stop());
  const port = await ui.ready;
  const ok = await post(port, ui.token, { action: "step", intent: IDS.code, n: 3, done: true });
  expect(ok.status).toBe(200);
  expect(JSON.parse(ok.body)).toEqual({ ok: true, message: "Ticked step 3." });
  await post(port, ui.token, { action: "step", intent: IDS.code, n: 3, done: false });
  expect(f.calls).toEqual([
    { action: "step", intent: IDS.code, n: 3, done: true },
    { action: "step", intent: IDS.code, n: 3, done: false },
  ]);

  // The real action ticks in the database, with the time, and refuses what isn't a step (SHIP-22).
  const db = f.db;
  const actions = createActions({
    db,
    store: f.store,
    config: testConfig(),
    clock: new TestClock(NOW),
    github: { owner: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }) },
  });
  setMission(f, IDS.code, "stage = 'steps'", { steps: STEPS });
  expect(await actions.step!(IDS.code, 3, true)).toBe(
    "ticked 3; steps left: 1. add the secret (the release needs it)",
  );
  expect(tickSteps(db, IDS.code, [3], false, new Date(NOW * 1000))).toContain("3. enable the setting");
  await expect(actions.step!(IDS.code, 9, true)).rejects.toThrow("step 9 isn't one of");
});

test("ui: stage map shows your steps", () => {
  const t = (min: number, from: Stage, event: string, to: Stage) => ({
    at: NOW - 3600 + min * 60,
    from_stage: from,
    event,
    to_stage: to,
    why: null,
  });
  const moves = [
    t(0, "pick", "ok", "build"),
    t(2, "build", "ok", "merge"),
    t(3, "merge", "code_merged", "steps"),
  ];
  const map = stageMap({ attempt: 1, created: NOW - 3600, stage: "steps" }, moves, [], NOW);
  // Your steps follows Merging, listed only because the attempt visited it, and it waits on the owner.
  expect(map.stages.map((s) => s.name).slice(-2)).toEqual(["Merging", "Your steps"]);
  expect(map.stages.find((s) => s.id === "steps")!.visits.map((v) => v.outcome)).toEqual(["waiting on you"]);
  const without = stageMap({ attempt: 1, created: NOW - 3600, stage: "done" }, moves.slice(0, 2), [], NOW);
  expect(without.stages.map((s) => s.id)).not.toContain("steps");
});

test("ui: your steps in the airspace", () => {
  // At `steps` a plane sits at the deploy station; held before the merge, at the gate's `you` station.
  expect(stationOf({ stage: "steps", from_stage: "steps", waiting: "your steps" })).toBe("deploy");
  expect(stationOf({ stage: "blocked", from_stage: "gate", waiting: "your steps first" })).toBe(
    "code-review",
  );
  expect(stationOf({ stage: "blocked", from_stage: "gate", waiting: "CI red" })).toBe("code");
  const m = { step: "", data: "{}" };
  expect(shipWords({ ...m, stage: "steps", waiting: "your steps" })).toBe("Waiting for your steps");
  expect(shipWords({ ...m, stage: "blocked", waiting: "your steps first" })).toBe(
    "Waiting for your steps before merging",
  );
});

test("ui: unverified is shown apart from done", async () => {
  expect(finishedState({ verified: "no" })).toMatchObject({
    key: "unverified",
    label: "Merged, not verified live",
  });
  expect(finishedState({ verified: null }).key).toBe("done");
  expect(stateOf({ stage: "unverified", waiting: null } as never, NOW).key).toBe("unverified");
  const f = fixture();
  const i = f.store.done.find((x) => x.id === IDS.done1)!;
  i.verified = "no";
  const page = (await intentPage(f.sources, IDS.done1))!;
  expect(page.state.key).toBe("unverified");
  expect(page.nothingLive).toBeUndefined();
  const b = await board(f.sources);
  const cell = b.repos.flatMap((r) => r.cells.done ?? []).find((c) => c.intent === IDS.done1)!;
  expect(cell.state.key).toBe("unverified");
  // The other done intents stay done.
  expect(
    b.repos.flatMap((r) => r.cells.done ?? []).filter((c) => c.state.key === "done").length,
  ).toBeGreaterThan(0);
});

test("ui: nothing to check live shows as done", async () => {
  const f = fixture();
  setMission(f, IDS.done1, "stage = 'done'", { liveNoneWhy: "Only the docs changed." });
  const page = (await intentPage(f.sources, IDS.done1))!;
  expect(page.state.key).toBe("done");
  expect(page.nothingLive).toBe("Only the docs changed.");
});
