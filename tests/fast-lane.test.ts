// The fast lane's order (FAST-2..5): the lane, the pick, the slots and the merge queue. Pure.

import { expect, test } from "vitest";
import { isHolder, laneOf, stampsFor } from "../src/fast-lane.ts";
import type { Stage } from "../src/machine.ts";
import type { Mission } from "../src/mission.ts";
import { decide, type PickState } from "../src/pick.ts";
import { headOf, queueOf } from "../src/queue.ts";
import { bestReady, returningIn, workingIn } from "../src/slots.ts";
import { at, listing } from "./intents/fixtures.ts";

let next = 1;
function mission(intent: string, stage: Stage, data: Record<string, unknown> = {}, repo = "web"): Mission {
  const id = next++;
  return {
    id,
    intent,
    repo,
    stage,
    from_stage: null,
    waiting: null,
    merge_sha: null,
    updated: 0,
    data: JSON.stringify(data),
  } as unknown as Mission;
}

const A = "261001-0900";
const B = "261001-0901";
const C = "261001-0902";
const FAST = "u: 5\ni: 5\nfast: true\n";
const intents = (...extra: string[]) =>
  listing([
    at(`intents/${A}-a`, FAST, "web", "A"),
    at(`intents/${B}-b`, FAST, "web", "B"),
    at(`intents/${C}-c`, extra[0] ?? "u: 5\ni: 5\n", "web", "C"),
  ]).open;

function state(o: Partial<PickState> = {}): PickState {
  return {
    cutoff: 7,
    paused: false,
    blocked: null,
    repos: new Set(["web"]),
    full: new Map(),
    cooling: new Map(),
    active: new Set(),
    defaultModel: "opus",
    ...o,
  };
}

test("fast: a second fast intent waits as the next fast one", () => {
  const open = intents();
  const first = mission(A, "build", { fastLane: 1 });
  expect(laneOf([first], open, "web").busy.map((m) => m.intent)).toEqual([A]);
  const d = decide(listing(open.map((i) => at(i.dir, i.fast ? FAST : "u: 5\ni: 5\n", i.repo, i.title))), {
    ...state(),
    active: new Set([A]),
    lane: new Map([["web", A]]),
  });
  expect(d.skipped).toContainEqual({ id: B, reason: `waiting: ${A} is the fast lane of web` });
  // The other intents of the repo are not held by the lane.
  expect(d.pick?.id).toBe(C);
});

test("fast: the lane frees when the first finishes", () => {
  const open = intents();
  const done = mission(A, "done", { fastLane: 1 });
  const lane = laneOf([done], open, "web");
  expect(lane.busy).toEqual([]);
  expect(isHolder(done)).toBe(false);
  expect(lane.next?.id).toBe(A);
  const waiting = mission(B, "build");
  expect(stampsFor([done, waiting], open).set.map((m) => m.intent)).toEqual([B]);
});

test("fast: an intent waiting on the owner gives up the lane", () => {
  const open = intents();
  const held = mission(A, "approval:merge", { fastLane: 1 });
  const lane = laneOf([held], open, "web");
  expect(lane.busy).toEqual([]);
  // The next fast intent, with a mission, takes the lane while the first waits.
  const other = mission(B, "build");
  expect(stampsFor([held, other], open).set.map((m) => m.intent)).toEqual([B]);
});

test("fast: the owner's decision gives the lane back without stopping the other", () => {
  const open = intents();
  const back = mission(A, "build", { fastLane: 1 });
  const other = mission(B, "build", { fastLane: 2 });
  const lane = laneOf([back, other], open, "web");
  // Both are in the lane and keep running; no third fast intent is handed the lane.
  expect(lane.busy.map((m) => m.intent)).toEqual([A, B]);
  expect(stampsFor([back, other, mission(C, "build")], open).set).toEqual([]);
  // The first one is first in line for the next slot.
  expect(workingIn([back, other], "web")).toHaveLength(2);
});

test("fast: a running intent that is marked takes the lane when it is free", () => {
  const open = intents();
  const running = mission(A, "build");
  expect(isHolder(running)).toBe(false);
  expect(stampsFor([running], open).set).toEqual([running]);
  // Busy lane: it keeps running as a normal one.
  const busy = mission(B, "build", { fastLane: 1 });
  expect(stampsFor([running, busy], open).set).toEqual([]);
});

test("fast: a fast intent starts past the ahead limit and the cutoff", () => {
  const l = listing([
    at(`intents/${A}-a`, "u: 1\ni: 1\nfast: true\n", "web", "A"),
    at(`intents/${C}-c`, "u: 5\ni: 5\n", "web", "C"),
  ]);
  const full = new Map([["web", { working: 1, owner: 0, limit: 1, ownerLimit: 4, ids: ["261000-0900"] }]]);
  const d = decide(l, state({ full }));
  expect(d.pick?.id).toBe(A);
});

test("fast: a paused repo still holds a fast intent back", () => {
  const l = listing([at(`intents/${A}-a`, FAST, "web", "A")]);
  const d = decide(l, state({ paused: true }));
  expect(d.pick).toBeNull();
  expect(d.skipped).toEqual([{ id: A, reason: "paused" }]);
  const unknown = decide(l, state({ repos: new Set() }));
  expect(unknown.pick).toBeNull();
});

test("fast: a free run slot goes to the fast mission first", () => {
  const l = listing([
    at(`intents/${A}-a`, "u: 3\ni: 3\n", "web", "A"),
    at(`intents/${B}-b`, "u: 1\ni: 1\nfast: true\n", "web", "B"),
  ]);
  const normal = mission(A, "build", { idle: true, returning: 5 });
  const fast = mission(B, "build", { idle: true, returning: 9, fastLane: 1 });
  expect(returningIn([normal, fast], "web", l).map((m) => m.intent)).toEqual([B, A]);
});

test("fast: the free build slot goes to the fast mission", () => {
  const l = listing([
    at(`intents/${A}-a`, "u: 5\ni: 5\n", "web", "A"),
    at(`intents/${B}-b`, "u: 1\ni: 1\nfast: true\n", "web", "B"),
  ]);
  const normal = mission(A, "plan", { ready: 1 });
  const fast = mission(B, "plan", { ready: 50, fastLane: 1 });
  expect(bestReady([normal, fast], "web", l)?.intent).toBe(B);
});

test("fast: a running build is not stopped", () => {
  const running = mission(A, "build");
  const fast = mission(B, "plan", { ready: 5, fastLane: 1 });
  // The fast mission is not a worker yet: the running build still holds its slot.
  expect(workingIn([running, fast], "web").map((m) => m.intent)).toEqual([A]);
  expect(stampsFor([running, fast], intents()).clear).toEqual([]);
});

test("fast: a fast mission is head of the merge queue", () => {
  const old = mission(A, "merge", { queuedAt: 10 });
  const fast = mission(B, "merge", { queuedAt: 90, fastLane: 1 });
  const ms = [old, fast];
  expect(queueOf(ms, "web").map((m) => m.intent)).toEqual([B, A]);
  expect(headOf(ms, "web")?.intent).toBe(B);
});

test("fast: the landing mission stays head", () => {
  const landing = mission(A, "build", { queuedAt: 50, landing: { since: 60 } });
  const fast = mission(B, "merge", { queuedAt: 90, fastLane: 1 });
  expect(headOf([fast, landing], "web")?.intent).toBe(A);
});
