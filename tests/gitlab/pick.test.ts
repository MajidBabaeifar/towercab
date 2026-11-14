// GitLab repos take part in picking like any other (GL-13).

import { expect, test } from "vitest";
import { decide, type PickState } from "../../src/pick.ts";
import { nextDue } from "../../src/readiness.ts";
import { testConfig } from "../helpers/world.ts";

const intent = (id: string, repo: string) =>
  ({
    id,
    repo,
    u: 5,
    i: 5,
    a: 3,
    after: [],
    repos: [],
    done: false,
    stage: null,
    waiting: null,
  }) as never;

function state(repos: string[]): PickState {
  return {
    cutoff: 7,
    paused: false,
    blocked: null,
    repos: new Set(repos),
    full: new Map(),
    cooling: new Map(),
    active: new Set(),
    defaultModel: "opus",
  } as unknown as PickState;
}

test("gitlab: intents on a GitLab repo are picked", () => {
  const listing = (...open: never[]) => ({ open, done: [], doneIds: new Set(), unreadable: [] }) as never;
  const d = decide(listing(intent("261105-0900", "proj")), state(["proj"]));
  expect(d.pick?.id).toBe("261105-0900");
  expect(d.skipped).toEqual([]);
  // The same order and `after` rule as for any repo: the better intent goes first.
  const two = decide(
    {
      open: [{ ...(intent("261105-0901", "web") as object), u: 3, i: 3 }, intent("261105-0902", "proj")],
      done: [],
      doneIds: new Set(),
      unreadable: [],
    } as never,
    state(["proj", "web"]),
  );
  expect(two.pick?.id).toBe("261105-0902");
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
