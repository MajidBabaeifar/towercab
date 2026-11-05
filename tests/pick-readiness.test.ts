// A repo that is not ready (LOOP-70, LOOP-71, LOOP-72): what the picker, `start`, `status`, `repo list`
// and `doctor` do with the stored readiness.

import { expect, test } from "vitest";
import { applyCommand, insertCommand } from "../src/commands.ts";
import { Db } from "../src/db.ts";
import { doctor } from "../src/doctor.ts";
import type { Intent, IntentStore } from "../src/intents/types.ts";
import { decide, type PickState } from "../src/pick.ts";
import { blockingRepos } from "../src/readiness.ts";
import {
  type Check,
  type Item,
  type Kind,
  type Readiness,
  repoReadiness,
  requiredSetup,
  type Stored,
} from "../src/repo/readiness.ts";
import { repoList } from "../src/repos.ts";
import { renderStatus } from "../src/status.ts";
import { FakeTools } from "./helpers/tools.ts";
import { testConfig, testHome } from "./helpers/world.ts";
import { at, listing } from "./intents/fixtures.ts";

const NOW = 1_793_000_000;

/** A library repo with `publish` missing; blocks when `confirmed` and `mode` is block. */
function readiness(confirmed: boolean, mode: "warn" | "block", waive: { item: Item; reason: string }[] = []) {
  const checks = new Map<Item, Check>(
    requiredSetup("library").map((i) => [
      i,
      i === "publish" ? { state: "missing" as const } : { state: "present" as const },
    ]),
  );
  return repoReadiness("library" as Kind, confirmed, checks, waive, mode);
}

function store(db: Db, repo: string, r: Readiness): void {
  const s: Stored = { base: "abc", at: NOW, readiness: r, goLive: null, hasLive: false };
  db.setMeta(`readiness:${repo}`, JSON.stringify(s));
}

function state(db: Db, o: Partial<PickState> = {}): PickState {
  const config = testConfig({ repos: { web: { github: "owner/web" }, api: { github: "owner/api" } } });
  return {
    cutoff: 7,
    paused: false,
    blocked: null,
    repos: new Set(config.repos.keys()),
    full: new Map(),
    cooling: new Map(),
    active: new Set(),
    defaultModel: "opus",
    notReady: new Map([...blockingRepos(db, config)].map(([n]) => [n, "1 missing (publish)"] as const)),
    ...o,
  };
}

const two = () =>
  listing([
    at("intents/261001-0900-a", "u: 5\ni: 5\n", "web", "Plain"),
    at("intents/261001-0901-b", "u: 4\ni: 4\n", "api", "Other repo"),
  ]);

test("loop: a blocking repo starts no new intent", () => {
  const db = Db.memory();
  store(db, "web", readiness(true, "block"));
  const d = decide(two(), state(db));
  expect(d.pick?.id).toBe("261001-0901");
  expect(d.skipped).toEqual([{ id: "261001-0900", reason: "repo not ready: 1 missing (publish)" }]);
});

test("loop: an unconfirmed or warn repo keeps starting intents", () => {
  for (const r of [
    readiness(false, "block"),
    readiness(true, "warn"),
    readiness(true, "block", [{ item: "publish", reason: "later" }]),
  ]) {
    const db = Db.memory();
    store(db, "web", r);
    const d = decide(two(), state(db));
    expect(d.pick?.id).toBe("261001-0900");
    expect(d.skipped).toEqual([]);
  }
  // A repo nobody checked yet is not held either.
  expect(decide(two(), state(Db.memory())).pick?.id).toBe("261001-0900");
});

test("loop: running intents finish in a blocking repo", () => {
  const db = Db.memory();
  store(db, "web", readiness(true, "block"));
  const l = listing([
    at("intents/261001-0900-run", "u: 5\ni: 5\n", "web", "Running"),
    at("intents/261001-0901-new", "u: 4\ni: 4\n", "web", "New"),
  ]);
  // The running intent has a mission: the picker leaves it alone and holds only the new one.
  const d = decide(l, state(db, { active: new Set(["261001-0900"]) }));
  expect(d.pick).toBeNull();
  expect(d.skipped.map((s) => s.id)).toEqual(["261001-0901"]);
});

test("loop: start is refused in a blocking repo", async () => {
  const db = Db.memory();
  store(db, "web", readiness(true, "block"));
  const intent = (setup: boolean) =>
    ({ id: "261001-0900", stage: null, repo: "web", setup }) as unknown as Intent;
  const applyCtx = { db, now: NOW, subject: () => ({ title: "t", repo: "web", link: null }) };
  const run = (i: Intent) =>
    applyCommand(
      { db, store: { get: async () => i } as unknown as IntentStore, applyCtx, now: new Date(NOW * 1000) },
      {
        id: insertCommand(db, { name: "start", arg: i.id, source: "cli" }, NOW),
        name: "start",
        arg: i.id,
        text: "",
        source: "cli",
        created: NOW,
        applied_at: null,
        result: null,
      },
    );
  expect(await run(intent(false))).toBe("start: web is not ready: publish");
  expect(db.meta("start:261001-0900")).toBeNull();
  // The setup intent may start.
  expect(await run(intent(true))).toMatch("starting 261001-0900");
});

test("loop: a repo that becomes ready is picked on the same pass", () => {
  const db = Db.memory();
  store(db, "web", readiness(true, "block"));
  expect(decide(two(), state(db)).pick?.id).toBe("261001-0901");
  // The owner waives the item (or the setup lands): the next check stores a ready repo.
  store(db, "web", readiness(true, "block", [{ item: "publish", reason: "not released yet" }]));
  expect(decide(two(), state(db)).pick?.id).toBe("261001-0900");
});

test("loop: a setup intent is picked in a blocking repo", () => {
  const db = Db.memory();
  store(db, "web", readiness(true, "block"));
  const l = listing([
    at("intents/261001-0900-a", "u: 5\ni: 5\n", "web", "Plain"),
    at("intents/261001-0901-s", "u: 3\ni: 3\nsetup: true\n", "web", "Set web up"),
  ]);
  expect(l.open.find((i) => i.id === "261001-0901")?.setup).toBe(true);
  const d = decide(l, state(db));
  expect(d.pick?.id).toBe("261001-0901");
  expect(d.skipped.map((s) => s.id)).toEqual(["261001-0900"]);
});

test("loop: only one setup intent per repo at a time", () => {
  const db = Db.memory();
  store(db, "web", readiness(true, "block"));
  const l = listing([
    at("intents/261001-0900-s1", "u: 5\ni: 5\nsetup: true\n", "web", "Setup one"),
    at("intents/261001-0901-s2", "u: 4\ni: 4\nsetup: true\n", "web", "Setup two"),
  ]);
  const d = decide(l, state(db, { active: new Set(["261001-0900"]) }));
  expect(d.pick).toBeNull();
  expect(d.skipped).toEqual([{ id: "261001-0901", reason: "261001-0900 is already setting up web" }]);
  // A setup intent in a repo that doesn't block is an ordinary intent.
  expect(decide(l, state(Db.memory(), { active: new Set(["261001-0900"]) })).pick?.id).toBe("261001-0901");
});

test("status: a not-ready repo is shown", () => {
  const db = Db.memory();
  store(db, "web", readiness(true, "block"));
  store(db, "api", readiness(false, "warn"));
  const text = renderStatus({
    db,
    listing: null,
    listingError: null,
    running: null,
    version: "1",
    now: NOW,
    problems: [],
    next: "next: nothing open",
    prLink: () => null,
    queued: new Set(),
  });
  expect(text).toContain("not ready: api · 2 missing · warning only");
  expect(text).toContain("not ready: web · 1 missing · new work waits");
});

test("cli: repo list shows not ready", () => {
  const db = Db.memory();
  const config = testConfig();
  db.run(
    "INSERT INTO repos (name, github, path, base, workers, ahead, env, source, added) VALUES ('web', 'owner/web', '', 'main', 1, 3, '{}', 'cli', ?)",
    NOW,
  );
  expect(repoList(db, "/h")).not.toContain("not ready");
  store(db, "web", readiness(true, "block"));
  expect(repoList(db, "/h")).toMatch(/ · not ready \(1 missing, blocking\)$/);
  store(db, "web", readiness(false, "block"));
  expect(repoList(db, "/h")).toMatch(/ · not ready \(2 missing, warning\)$/);
  expect(config.repos.has("web")).toBe(true);
});

test("doctor: not-ready repos are named", async () => {
  const db = Db.memory();
  const config = testConfig();
  store(db, "web", readiness(true, "block", []));
  const r = await doctor({
    config,
    home: testHome(),
    tools: new FakeTools(),
    github: null,
    quick: false,
    db,
  });
  expect(r.lines).toContain("web: not ready, blocking new work");
  expect(r.lines).toContain("web: missing publish: Release publishing is not set up: add a publish job");
});
