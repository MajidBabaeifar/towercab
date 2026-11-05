// INT-42: a multi-repo intent starts only when every repo it names is known and ready.

import { expect, test } from "vitest";
import { decide, type PickState } from "../src/pick.ts";
import { at, listing } from "./intents/fixtures.ts";

function state(repos: string[], o: Partial<PickState> = {}): PickState {
  return {
    cutoff: 7,
    paused: false,
    blocked: null,
    repos: new Set(repos),
    full: new Map(),
    cooling: new Map(),
    active: new Set(),
    defaultModel: "opus",
    ...o,
  };
}

test("pick: an unknown repo in repos is not started", () => {
  const l = listing([
    at("intents/261001-0900-wide", "u: 5\ni: 5\nrepos: [infra, nowhere]\n", "specfork", "Wide"),
    at("intents/261001-0901-plain", "", "specfork", "Plain"),
  ]);
  const d = decide(l, state(["specfork", "infra"]));
  expect(d.pick?.id).toBe("261001-0901");
  expect(d.writes).toEqual([{ id: "261001-0900", waiting: "bad repos:", why: "nowhere" }]);
  expect(d.skipped).toEqual([{ id: "261001-0900", reason: "bad repos: nowhere" }]);
});

test("pick: a repo that is not ready holds the intent", () => {
  const l = listing([at("intents/261001-0900-wide", "repos: [infra]\n", "specfork", "Wide")]);
  const d = decide(l, state(["specfork", "infra"], { notReady: new Map([["infra", "2 missing (CI)"]]) }));
  expect(d.pick).toBeNull();
  expect(d.writes).toEqual([]);
  expect(d.skipped).toEqual([{ id: "261001-0900", reason: "repo infra not ready: 2 missing (CI)" }]);
  expect(decide(l, state(["specfork", "infra"])).pick?.id).toBe("261001-0900");
});
