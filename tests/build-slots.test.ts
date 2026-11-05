// Build slots held only by missions that work (LOOP-110..112): the real loop and database with faked
// stage handlers, and `renderStatus` on a small database.

import { join } from "node:path";
import { expect, test } from "vitest";
import { Db } from "../src/db.ts";
import type { Ctx, Handler, Handlers, Progress } from "../src/handlers.ts";
import { apply, ORDER, ok, wait } from "../src/machine.ts";
import { insertMission, type Mission } from "../src/mission.ts";
import { renderStatus } from "../src/status.ts";
import type { ChildExit, ChildSpec } from "../src/tools.ts";
import { intent, TARGET } from "./helpers/flows.ts";
import { Pipe } from "./helpers/pipe.ts";
import { at, listing } from "./intents/fixtures.ts";

const A = "261026-1000";
const B = "261026-1001";
const C = "261026-1002";
const D = "261026-1003";

type Step = (m: Mission, cx: Ctx) => Progress | Promise<Progress>;

function fake(step: Step): Handlers {
  const h: Handler = { step: async (cx, m) => step(m, cx), finish: async () => ({ done: ok() }) };
  return Object.fromEntries(ORDER.filter((s) => s !== "done").map((s) => [s, h]));
}

/** A child the test ends by hand (`end()`). */
function childOf(p: Pipe, kind: string) {
  let end!: (e: ChildExit) => void;
  const done = new Promise<ChildExit>((r) => {
    end = r;
  });
  p.tools.child(kind, () => done);
  const dir = p.home.runs("children");
  const spec: ChildSpec = {
    kind,
    argv: [kind],
    cwd: dir,
    env: {},
    stdout: join(dir, `${kind}.out`),
    stderr: join(dir, `${kind}.err`),
    slot: true,
  };
  return { spec, end: () => end({ code: 0, signal: null }) };
}

function files(...xs: { id: string; u?: number; i?: number }[]) {
  return Object.fromEntries(
    xs.map((x) => [
      `intents/${x.id}-t${x.id.slice(-1)}/intent.md`,
      intent({ title: `T${x.id.slice(-1)}`, repo: "web", u: x.u ?? 4, i: x.i ?? 4, extra: "" }),
    ]),
  );
}

const byIntent = (p: Pipe, id: string) =>
  p.db.all<Mission>("SELECT * FROM missions WHERE intent = ? ORDER BY id", id);
const stageOf = (p: Pipe, id: string) => byIntent(p, id)[0]?.stage;
const dataOfIntent = (p: Pipe, id: string) => JSON.parse(byIntent(p, id)[0]!.data) as Record<string, unknown>;
const approvePlan = (p: Pipe, id: string) => p.loop.move(byIntent(p, id)[0]!, { event: "plan_merged" });
const merged = (p: Pipe, id: string) =>
  p.loop.move(byIntent(p, id)[0]!, { event: "code_merged", set: { merge_sha: "abc", merged_by: "owner" } });

async function pass(p: Pipe, n = 1) {
  for (let i = 0; i < n; i++) {
    await p.loop.pass();
    p.clock.advance(61);
  }
}

const web = (o: { workers?: number; ahead?: number } = {}) => ({
  repos: { web: { github: "owner/web", ahead: o.ahead ?? 8, ...(o.workers ? { workers: o.workers } : {}) } },
});

/**
 * Design and plan run through. A build goes on until the test merges it (`holds`), waits on the owner's
 * merge (`owner`), or runs on to the checks, which poll for as long as the intent isn't in `go`.
 */
function world(opts: { holds?: string[]; owner?: string[]; go?: Set<string>; review?: () => ChildSpec }) {
  return fake((m) => {
    if (m.stage === "pick" || m.stage === "design") return { done: ok() };
    if (m.stage === "plan") return { done: wait("approve plan") };
    if (m.stage === "build") {
      if (opts.holds?.includes(m.intent)) return { poll: 3600 };
      if (opts.owner?.includes(m.intent)) return { done: wait("review and merge PR") };
      return { done: ok() };
    }
    if (m.stage === "ci") return opts.go?.has(m.intent) ? { done: ok() } : { poll: 120 };
    if (m.stage === "review" && opts.review) return { spawn: opts.review() };
    return { done: ok() };
  });
}

async function setup(ids: { id: string; u?: number; i?: number }[], handlers: Handlers, workers = 1) {
  const p = new Pipe(TARGET, files(...ids));
  await p.start(web({ workers }), { handlers });
  await pass(p, 8);
  return p;
}

test("loop: missions waiting on CI do not hold build slots", async () => {
  const p = await setup([{ id: A }, { id: B }, { id: C }], world({ holds: [C] }), 2);
  approvePlan(p, A);
  await pass(p, 6);
  approvePlan(p, B);
  await pass(p, 6);
  // Both workers' missions only wait for GitHub's checks.
  expect([stageOf(p, A), stageOf(p, B)]).toEqual(["ci", "ci"]);
  approvePlan(p, C);
  await pass(p, 3);
  // A third intent starts building at once; it is not ready-and-waiting.
  expect(stageOf(p, C)).toBe("build");
  expect(dataOfIntent(p, C).ready).toBeUndefined();
});

test("loop: missions waiting on the owner do not hold build slots", async () => {
  const p = await setup([{ id: A }, { id: B }], world({ owner: [A], holds: [B] }));
  approvePlan(p, A);
  await pass(p, 4);
  expect(stageOf(p, A)).toBe("approval:merge");
  approvePlan(p, B);
  await pass(p, 3);
  expect(stageOf(p, B)).toBe("build");
  expect(dataOfIntent(p, B).ready).toBeUndefined();
});

test("loop: at the cap of three times workers nothing new builds", async () => {
  const p = await setup(
    [{ id: A }, { id: B }, { id: C }, { id: D }],
    world({ owner: [A, B, C], holds: [D] }),
  );
  for (const id of [A, B, C]) {
    approvePlan(p, id);
    await pass(p, 3);
    expect(stageOf(p, id)).toBe("approval:merge");
  }
  // Three missions are between build and merge, the cap for one worker.
  approvePlan(p, D);
  await pass(p, 4);
  expect(stageOf(p, D)).toBe("approval:plan");
  expect(dataOfIntent(p, D).ready).toBeTypeOf("number");
  // One merges: the cap has room again and D builds.
  merged(p, A);
  await pass(p, 4);
  expect(stageOf(p, D)).toBe("build");
});

test("loop: a repair at ci holds a slot", async () => {
  const repair = { on: false };
  let child!: ReturnType<typeof childOf>;
  const base = world({ holds: [C] });
  const handlers = fake((m, cx) => {
    if (m.stage === "ci" && m.intent === A) return repair.on ? { spawn: child.spec } : { poll: 120 };
    return (base.ci as Handler).step(cx, m) as never;
  });
  const p = new Pipe(TARGET, files({ id: A }, { id: B }));
  child = childOf(p, "repair");
  await p.start(web(), {
    handlers: {
      ...handlers,
      design: base.design!,
      pick: base.pick!,
      plan: base.plan!,
      build: base.build!,
    },
  });
  await pass(p, 8);
  approvePlan(p, A);
  await pass(p, 6);
  expect(stageOf(p, A)).toBe("ci");
  repair.on = true;
  await pass(p, 4);
  expect(byIntent(p, A)[0]!.child_kind).toBe("repair");
  // The repair runs, so A holds the only slot again and B waits for it.
  approvePlan(p, B);
  await pass(p, 3);
  expect(stageOf(p, B)).toBe("approval:plan");
  expect(dataOfIntent(p, B).ready).toBeTypeOf("number");
  child.end();
});

/** A is at the checks and goes on to a review run; B builds on and holds the one slot; C and D are ready. */
async function returning(ids = [A, B, C], go = new Set<string>()) {
  const kids: Record<string, ReturnType<typeof childOf>> = {};
  const holder = ids[1]!;
  const p = new Pipe(
    TARGET,
    files(
      { id: ids[0]!, u: 3, i: 3 },
      { id: holder },
      { id: ids[2]! },
      ...(ids[3] ? [{ id: ids[3], u: 5, i: 5 }] : []),
    ),
  );
  for (const id of ids) kids[id] = childOf(p, `review-${id}`);
  let current = "";
  const handlers = world({ holds: [holder, ids[2]!], go, review: () => kids[current]!.spec });
  const wrapped = fake((m, cx) => {
    current = m.intent;
    return (handlers.ci as Handler).step(cx, m) as never;
  });
  await p.start(web(), { handlers: wrapped });
  await pass(p, 8);
  return { p, kids, go };
}

test("loop: a returning mission with every slot taken waits without starting", async () => {
  const { p, go } = await returning();
  approvePlan(p, A);
  await pass(p, 6);
  expect(stageOf(p, A)).toBe("ci");
  // B builds and holds the one slot; A's checks end and its review wants to run.
  approvePlan(p, B);
  await pass(p, 3);
  expect(stageOf(p, B)).toBe("build");
  go.add(A);
  await pass(p, 8);
  const a = byIntent(p, A)[0]!;
  expect(a.stage).toBe("review");
  expect(a.child_kind).toBeNull();
  expect(dataOfIntent(p, A).returning).toBeTypeOf("number");
  expect(dataOfIntent(p, A).launched).toBeUndefined();
});

test("loop: a returning mission takes the next free slot before a new build", async () => {
  const { p, go } = await returning();
  approvePlan(p, A);
  await pass(p, 6);
  approvePlan(p, B);
  await pass(p, 3);
  go.add(A);
  await pass(p, 8);
  // C's plan is approved while A waits for the slot: C is ready behind it.
  approvePlan(p, C);
  await pass(p, 3);
  expect(stageOf(p, C)).toBe("approval:plan");
  // B ends: the free slot goes to A's review, not to C's build.
  merged(p, B);
  await pass(p, 4);
  expect(byIntent(p, A)[0]!.child_kind).toBe("review-" + A);
  expect(stageOf(p, C)).toBe("approval:plan");
  expect(dataOfIntent(p, C).ready).toBeTypeOf("number");
  expect(dataOfIntent(p, A).returning).toBeUndefined();
});

test("loop: returning missions take slots by priority", async () => {
  // A is low priority, D high; both are at the checks while B holds the slot.
  const { p, go } = await returning([A, B, C, D]);
  approvePlan(p, A);
  await pass(p, 6);
  approvePlan(p, D);
  await pass(p, 6);
  expect([stageOf(p, A), stageOf(p, D)]).toEqual(["ci", "ci"]);
  approvePlan(p, B);
  await pass(p, 3);
  go.add(A);
  go.add(D);
  await pass(p, 8);
  expect([byIntent(p, A)[0]!.child_kind, byIntent(p, D)[0]!.child_kind]).toEqual([null, null]);
  merged(p, B);
  await pass(p, 3);
  // The slot goes to D although A has waited longer.
  expect(byIntent(p, D)[0]!.child_kind).toBe("review-" + D);
  expect(byIntent(p, A)[0]!.child_kind).toBeNull();
});

const NOW = 1_793_000_000;

/** A mission in `web` taken `oks` steps along its way (3 = build, 7 = ci, 8 = review). */
function mission(db: Db, id: string, oks: number, data: Record<string, unknown> = {}, repo = "web") {
  const cx = { db, now: NOW, subject: () => ({ title: "t", repo, link: null }) };
  let m = db.tx(() => insertMission(db, { intent: id, slug: "x", repo, model: "opus", a: 3 }, NOW));
  for (let i = 0; i < oks; i++) m = apply(cx, m, { event: "ok" });
  db.run("UPDATE missions SET data = ? WHERE id = ?", JSON.stringify(data), m.id);
  return db.get<Mission>("SELECT * FROM missions WHERE id = ?", m.id)!;
}

function status(db: Db, queued: number[] = [], workers = 1) {
  const l = listing([A, B, C, D].map((id) => at(`intents/${id}-x`, "", "web", `T${id.slice(-1)}`)));
  return renderStatus({
    db,
    listing: l,
    listingError: null,
    running: 1,
    version: "1",
    now: NOW,
    problems: [],
    next: "next: nothing can run now",
    prLink: () => null,
    queued: new Set(queued),
    workers: () => workers,
  });
}

test("status: build slots used and missions waiting outside slots", () => {
  const db = Db.memory();
  mission(db, A, 3);
  mission(db, B, 7, { idle: true });
  mission(db, C, 7, { idle: true });
  expect(status(db)).toContain("build slots: web 1 of 1 used, 2 waiting outside slots (cap 3)");
  expect(status(db, [], 2)).toContain("build slots: web 1 of 2 used, 2 waiting outside slots (cap 6)");
});

test("status: a ready mission at the cap names the cap", () => {
  const db = Db.memory();
  mission(db, A, 3);
  mission(db, B, 7, { idle: true });
  mission(db, C, 7, { idle: true });
  const ready = mission(db, D, 2, { ready: NOW });
  const text = status(db, [ready.id]);
  expect(text).toContain(
    "- 261026-1003 web: T3 · waiting: repo is at the cap of 3 missions between build and merge, 1 working and 2 waiting",
  );
  expect(text).not.toContain("ready to build");
  // Below the cap it is held by the working mission.
  const small = Db.memory();
  mission(small, A, 3);
  mission(small, B, 7, { idle: true });
  const r = mission(small, D, 2, { ready: NOW });
  expect(status(small, [r.id])).toContain("T3 · ready to build, behind 261026-1000");
});

test("status: a returning mission names the one ahead", () => {
  const db = Db.memory();
  mission(db, A, 3);
  mission(db, B, 8, { idle: true, returning: NOW - 20 });
  expect(status(db)).toContain("- 261026-1001 web: T1 · waiting for a build slot, behind 261026-1000");
  // With no working mission, the later one waits behind the earlier returning one.
  const two = Db.memory();
  mission(two, B, 8, { idle: true, returning: NOW - 20 });
  mission(two, C, 8, { idle: true, returning: NOW - 10 });
  const text = status(two);
  expect(text).toContain("- 261026-1002 web: T2 · waiting for a build slot, behind 261026-1001");
  expect(text).toContain("- 261026-1001 web: T1 · waiting for a build slot\n");
});
