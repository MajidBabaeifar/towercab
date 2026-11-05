// Draining for a self-update (LOOP-108, LOOP-109): the real loop and the real update check against a
// temp clone of a bare repo, with stage handlers faked so each test decides what a stage does.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { Handler } from "../src/handlers.ts";
import { ok, wait } from "../src/machine.ts";
import type { Mission } from "../src/mission.ts";
import { renderStatus } from "../src/status.ts";
import type { ChildExit, ChildSpec } from "../src/tools.ts";
import { intent, TARGET } from "./helpers/flows.ts";
import { Pipe } from "./helpers/pipe.ts";
import { failResult, okResult } from "./helpers/tools.ts";
import { bareRepo, git, pushFiles, tempDir } from "./helpers/world.ts";

const A = "261026-1000";
const B = "261026-1001";
const C = "261026-1002";
const REPOS = { web: { github: "owner/web" }, api: { github: "owner/api" }, docs: { github: "owner/docs" } };
const REPO_OF: Record<string, string> = { [A]: "web", [B]: "api", [C]: "docs" };

const file = (id: string, u = 4) => ({
  [`intents/${id}-t${id.slice(-1)}/intent.md`]: intent({
    title: `T${id.slice(-1)}`,
    repo: REPO_OF[id]!,
    u,
    i: 4,
    extra: "",
  }),
});

interface World {
  p: Pipe;
  bare: string;
  checkout: string;
  /** Intents whose child was spawned, in order (a re-run appears twice). */
  spawns: string[];
  ends: Map<string, (e: ChildExit) => void>;
  /** While true, B's step has nothing to start yet (it polls). */
  hold: boolean;
  doctor: string;
}

async function world(
  o: {
    ids?: string[];
    drain?: number;
    kinds?: Record<string, string>;
    doctorOk?: boolean;
    hold?: boolean;
  } = {},
): Promise<World> {
  const ids = o.ids ?? [A];
  const bare = bareRepo({ "bin/towercab": "#!/bin/sh\n", "src/a.ts": "1\n" });
  const checkout = join(tempDir(), "towercab");
  git(tempDir(), "clone", "-q", bare, checkout);
  const p = new Pipe(TARGET, Object.assign({}, ...ids.map((id, n) => file(id, 5 - n))));
  const doctor = join(checkout, "bin", "towercab");
  p.tools.on("npm", () => okResult());
  p.tools.on(doctor, () => (o.doctorOk === false ? failResult("config: missing") : okResult("ok")));
  const w: World = { p, bare, checkout, spawns: [], ends: new Map(), hold: o.hold ?? false, doctor };
  const spec = (id: string): ChildSpec => {
    const dir = p.home.runs("children");
    return {
      kind: o.kinds?.[id] ?? "work",
      argv: [`k-${id}`],
      cwd: dir,
      env: {},
      stdout: join(dir, `${id}.out`),
      stderr: join(dir, `${id}.err`),
      slot: true,
    };
  };
  for (const id of [A, B, C]) {
    p.tools.routes.set(
      `k-${id}`,
      () =>
        new Promise<ChildExit>((res) => {
          w.spawns.push(id);
          w.ends.set(id, res);
        }),
    );
  }
  const h: Handler = {
    step: async (cx, m) => {
      if (m.stage === "pick") return { done: ok() };
      if (m.intent === B && w.hold) return { poll: 1 };
      cx.record(m, "work");
      return { spawn: spec(m.intent) };
    },
    finish: async () => ({ done: wait("approve spec") }),
  };
  const stages = [
    "pick",
    "design",
    "plan",
    "build",
    "verify",
    "proof",
    "publish",
    "ci",
    "review",
    "gate",
    "merge",
  ];
  await p.start(
    { repos: REPOS, agent: { parallel: 2 }, update: { drain_minutes: o.drain ?? 60 } },
    { handlers: Object.fromEntries(stages.map((s) => [s, h])), selfUpdate: true, codeRoot: checkout },
  );
  return w;
}

const tick = () => new Promise((r) => setTimeout(r, 5));

async function pass(w: World, seconds = 61) {
  const r = await w.p.loop.pass();
  w.p.clock.advance(seconds);
  return r;
}

async function until(w: World, cond: () => boolean, max = 12) {
  for (let i = 0; i < max && !cond(); i++) await pass(w);
  expect(cond()).toBe(true);
}

const mission = (w: World, id: string) =>
  w.p.db.get<Mission>("SELECT * FROM missions WHERE intent = ? ORDER BY id DESC LIMIT 1", id);

const short = (w: World) => git(w.bare, "rev-parse", "main").trim().slice(0, 7);

/** Children of the given intents run, then main moves ahead and one pass sets the drain. */
async function startDrain(w: World, running = [A]) {
  await until(w, () => running.every((id) => w.spawns.includes(id)));
  pushFiles(w.bare, { "src/a.ts": "2\n" });
  await pass(w);
  expect(w.p.db.meta("draining")).toBe(short(w));
}

async function endChild(w: World, id: string) {
  w.ends.get(id)!({ code: 0, signal: null });
  await tick();
}

const kills = (w: World) => w.p.tools.kills.filter((k) => k.signal === "SIGTERM");

test("update: no child starts while main is ahead", async () => {
  const w = await world({ ids: [A, B], hold: true });
  await until(w, () => w.spawns.includes(A) && mission(w, B) !== undefined);
  await startDrain(w);
  w.hold = false;
  pushFiles(w.p.bares.intents!, file(C));
  for (let i = 0; i < 3; i++) await pass(w);
  // A goes on; B's step was asked to start a child and was held back; C was not picked.
  expect(w.spawns).toEqual([A]);
  expect(mission(w, A)!.child_kind).toBe("work");
  expect(mission(w, B)!.busy).toBe(0);
  expect(mission(w, C)).toBeUndefined();
  expect(w.p.loop.exitCode).toBe(0);
  expect(git(w.checkout, "rev-parse", "HEAD").trim()).not.toBe(git(w.bare, "rev-parse", "main").trim());
});

test("update: updates once the running child ends", async () => {
  const w = await world({ ids: [A, B], hold: true });
  await until(w, () => w.spawns.includes(A) && mission(w, B) !== undefined);
  await startDrain(w);
  await endChild(w, A);
  const r = await pass(w);
  expect(r.stop).toBe(true);
  expect(w.p.loop.exitCode).toBe(75);
  expect(git(w.checkout, "rev-parse", "HEAD").trim()).toBe(git(w.bare, "rev-parse", "main").trim());
  // The next process runs the new code and the held work starts.
  await w.p.loop.shutdown();
  w.hold = false;
  await w.p.reopen();
  await until(w, () => w.spawns.includes(B));
  expect(w.p.db.meta("draining")).toBeNull();
});

test("update: a drain is cleared when main is no longer ahead", async () => {
  const w = await world({ ids: [A, B], hold: true });
  await until(w, () => w.spawns.includes(A) && mission(w, B) !== undefined);
  await startDrain(w);
  // A fetch that fails says nothing: the drain stays.
  const url = git(w.checkout, "remote", "get-url", "origin").trim();
  git(w.checkout, "remote", "set-url", "origin", join(tempDir(), "gone.git"));
  await pass(w);
  expect(w.p.db.meta("draining")).toBe(short(w));
  // Main goes back to what the checkout runs: nothing to wait for, work starts again.
  git(w.checkout, "remote", "set-url", "origin", url);
  git(w.checkout, "push", "-q", "-f", "origin", "HEAD:main");
  w.hold = false;
  await pass(w);
  expect(w.p.db.meta("draining")).toBeNull();
  await until(w, () => w.spawns.includes(B));
});

test("update: status says draining for update", async () => {
  const w = await world();
  await startDrain(w);
  const status = (running: number | null) =>
    renderStatus({
      db: w.p.db,
      listing: null,
      listingError: null,
      running,
      version: "0.0.0",
      now: w.p.clock.now(),
      problems: [],
      next: "",
      prLink: () => null,
      queued: new Set(),
    }).split("\n")[0]!;
  expect(status(4242)).toContain(`draining for update to ${short(w)}`);
  expect(status(null)).not.toContain("draining");
});

/** A is running, main moves ahead, A ends, and the update's check fails: the old code goes on. */
async function failedUpdate() {
  const w = await world({ ids: [A, B], hold: true, doctorOk: false });
  await until(w, () => w.spawns.includes(A) && mission(w, B) !== undefined);
  await startDrain(w);
  const before = git(w.checkout, "rev-parse", "HEAD").trim();
  await endChild(w, A);
  await pass(w);
  return { w, before };
}

test("update: a failed commit is not drained for again", async () => {
  const { w, before } = await failedUpdate();
  expect(w.p.loop.exitCode).toBe(0);
  expect(git(w.checkout, "rev-parse", "HEAD").trim()).toBe(before);
  expect(w.p.db.meta("draining")).toBeNull();
  // Work goes on in the same process; main is still ahead but no drain starts for the same commit.
  w.hold = false;
  await until(w, () => w.spawns.includes(B));
  for (let i = 0; i < 3; i++) await pass(w);
  expect(w.p.db.meta("draining")).toBeNull();
  expect(w.p.tools.lines(w.doctor)).toEqual(["doctor --quick"]);
  // Main moves past the failed commit: the next drain starts.
  pushFiles(w.bare, { "src/a.ts": "3\n" });
  await pass(w);
  expect(w.p.db.meta("draining")).toBe(short(w));
});

test("update: a failed update sends one message naming the commit", async () => {
  const { w } = await failedUpdate();
  w.hold = false;
  for (let i = 0; i < 4; i++) await pass(w);
  const rows = w.p.db.all<{ key: string; text: string }>(
    "SELECT key, text FROM outbox WHERE key LIKE 'update:%'",
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.text).toContain(short(w));
  expect(w.p.logs.some((l) => l.includes(`self-update to ${short(w)} failed`))).toBe(true);
});

test("update: a drain past the limit updates anyway", async () => {
  const w = await world({ drain: 1 });
  await startDrain(w);
  await pass(w);
  expect(kills(w)).toEqual([{ kind: "work", signal: "SIGTERM" }]);
  await tick();
  const r = await pass(w);
  expect(r.stop).toBe(true);
  expect(w.p.loop.exitCode).toBe(75);
  expect(git(w.checkout, "rev-parse", "HEAD").trim()).toBe(git(w.bare, "rev-parse", "main").trim());
  expect(w.p.logs.some((l) => l.includes("reached its first limit") && l.includes("interrupted"))).toBe(true);
});

test("update: drain_minutes sets the limit", async () => {
  const w = await world({ drain: 2 });
  await startDrain(w);
  await pass(w);
  expect(kills(w)).toEqual([]);
  await pass(w);
  expect(kills(w)).toEqual([{ kind: "work", signal: "SIGTERM" }]);
});

test("update: a review or build gets one more drain_minutes to finish", async () => {
  for (const kind of ["review", "worker"]) {
    const w = await world({ drain: 1, kinds: { [A]: kind } });
    await startDrain(w);
    await pass(w);
    // The limit has passed and the run is spared; it ends by itself and the update goes ahead.
    expect(kills(w)).toEqual([]);
    expect(mission(w, A)!.child_kind).toBe(kind);
    await endChild(w, A);
    const r = await pass(w);
    expect(r.stop).toBe(true);
    expect(w.p.loop.exitCode).toBe(75);
    expect(kills(w)).toEqual([]);
  }
});

test("update: other children are cut off at the limit", async () => {
  const w = await world({ ids: [A, B], drain: 1, kinds: { [A]: "worker", [B]: "checks" } });
  await startDrain(w, [A, B]);
  await pass(w);
  expect(kills(w)).toEqual([{ kind: "checks", signal: "SIGTERM" }]);
});

test("update: a drain lasts at most twice drain_minutes", async () => {
  const w = await world({ drain: 1, kinds: { [A]: "worker" } });
  await startDrain(w);
  await pass(w);
  expect(kills(w)).toEqual([]);
  await pass(w);
  expect(kills(w)).toEqual([{ kind: "worker", signal: "SIGTERM" }]);
  await tick();
  const r = await pass(w);
  expect(r.stop).toBe(true);
  expect(w.p.loop.exitCode).toBe(75);
});

/** A is cut off by a drain past its limit and the update goes through. */
async function cutOff(doctorOk = true) {
  const w = await world({ drain: 1, doctorOk });
  await startDrain(w);
  const session = mission(w, A)!.session;
  await pass(w);
  await tick();
  await pass(w);
  return { w, session };
}

test("update: an interrupted mission resumes its session after the update", async () => {
  const { w, session } = await cutOff();
  expect(w.p.loop.exitCode).toBe(75);
  const m = mission(w, A)!;
  expect([m.stage, m.step, m.busy, m.child_pid]).toEqual(["design", "work", 0, null]);
  await w.p.loop.shutdown();
  await w.p.reopen();
  await until(w, () => w.spawns.filter((id) => id === A).length === 2);
  expect(mission(w, A)!.session).toBe(session);
});

test("update: an interrupted run is not counted as a crash", async () => {
  const { w } = await cutOff();
  expect(mission(w, A)!.unclean).toBe(0);
  await w.p.loop.shutdown();
  await w.p.reopen();
  expect(w.p.logs.some((l) => l.includes("didn't exit cleanly"))).toBe(false);
  expect(mission(w, A)!.unclean).toBe(0);
});

test("update: a failed forced update resumes the cut-off missions in the same process", async () => {
  const { w, session } = await cutOff(false);
  expect(w.p.loop.exitCode).toBe(0);
  expect(w.p.db.meta("draining")).toBeNull();
  await until(w, () => w.spawns.filter((id) => id === A).length === 2);
  const m = mission(w, A)!;
  expect(m.unclean).toBe(0);
  expect(m.session).toBe(session);
  expect(w.p.loop.exitCode).toBe(0);
});

test("update: a dirty checkout ends the drain", async () => {
  const w = await world();
  await startDrain(w);
  writeFileSync(join(w.checkout, "src/a.ts"), "my edit\n");
  await pass(w);
  expect(w.p.db.meta("draining")).toBeNull();
});
