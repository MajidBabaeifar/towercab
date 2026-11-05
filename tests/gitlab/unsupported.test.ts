// A GitLab repo can be added, but until the pipeline supports GitLab none of its intents is picked.

import { expect, test } from "vitest";
import { decide, GITLAB_NOT_YET, type PickState } from "../../src/pick.ts";
import { nextDue } from "../../src/readiness.ts";
import { testConfig } from "../helpers/world.ts";

test("gitlab: intents on a GitLab repo are not picked yet", () => {
  const intent = {
    id: "261105-0900",
    repo: "proj",
    u: 5,
    i: 5,
    a: 3,
    after: [],
    repos: [],
    done: false,
    stage: null,
    waiting: null,
  } as never;
  const state = {
    cutoff: 7,
    paused: false,
    blocked: null,
    repos: new Set(["proj"]),
    unsupported: new Set(["proj"]),
    full: new Map(),
    cooling: new Map(),
    active: new Set(),
    defaultModel: "opus",
  } as unknown as PickState;
  const d = decide({ open: [intent], done: [], doneIds: new Set(), unreadable: [] } as never, state);
  expect(d.pick).toBeNull();
  expect(d.writes).toEqual([]);
  expect(d.skipped).toEqual([{ id: "261105-0900", reason: GITLAB_NOT_YET("proj") }]);
});

test("gitlab: readiness does not check a GitLab repo", () => {
  const config = testConfig({ repos: { web: { github: "owner/web" } } });
  config.repos.set("proj", {
    name: "proj",
    github: "gitlab:g/proj",
    path: "",
    base: "main",
    workers: 1,
    ahead: 3,
    env: {},
  });
  const seen: string[] = [];
  const db = { meta: () => null } as never;
  for (let i = 0; i < 3; i++) {
    const r = nextDue({ config, db, clock: { now: () => 1e9, mono: () => 0 } } as never);
    if (r) {
      seen.push(r.name);
      break;
    }
  }
  expect(seen).toEqual(["web"]);
});
