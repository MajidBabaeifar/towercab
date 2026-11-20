// Pause (LOOP-113, LOOP-114): the real loop with stage handlers faked, so each test decides what a
// step does. Children are ended by hand.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { main } from "../src/cli.ts";
import { insertCommand } from "../src/commands.ts";
import { Db } from "../src/db.ts";
import { holdPushes } from "../src/github/paused.ts";
import type { PrState } from "../src/github/prs.ts";
import type { Ctx, Handler, Handlers } from "../src/handlers.ts";
import { Home } from "../src/home.ts";
import { ORDER, ok } from "../src/machine.ts";
import type { Mission } from "../src/mission.ts";
import { renderStatus } from "../src/status.ts";
import type { ChildExit, ChildSpec } from "../src/tools.ts";
import { intent, TARGET } from "./helpers/flows.ts";
import { Pipe } from "./helpers/pipe.ts";
import { FakeTools, okResult } from "./helpers/tools.ts";
import { bareRepo, tempDir } from "./helpers/world.ts";

const A = "261026-1000";
const FILES = {
  [`intents/${A}-t0/intent.md`]: intent({ title: "T0", repo: "web", u: 4, i: 4, extra: "" }),
};

interface World {
  p: Pipe;
  /** Runs started, in order. */
  spawns: number;
  ends: ((e: ChildExit) => void)[];
  /** Steps asked for (not counting the pick). */
  steps: number;
}

/** What the world's handlers do. */
interface Script {
  /** The stage steps: spawn a run (default) or poll. */
  step?: "spawn" | "poll";
  finish?: (m: Mission, cx: Ctx) => Promise<void>;
  /** The pick sets the PR the mission is polled on. */
  pr?: number;
  readPr?: () => Promise<PrState>;
}

async function world(s: Script = {}): Promise<World> {
  const p = new Pipe(TARGET, FILES);
  const w: World = { p, spawns: 0, ends: [], steps: 0 };
  p.tools.routes.set(
    "k-work",
    () =>
      new Promise<ChildExit>((res) => {
        w.spawns++;
        w.ends.push(res);
      }),
  );
  const spec = (): ChildSpec => {
    const dir = p.home.runs("children");
    return {
      kind: "work",
      argv: ["k-work"],
      cwd: dir,
      env: {},
      stdout: join(dir, "work.out"),
      stderr: join(dir, "work.err"),
      slot: true,
    };
  };
  const h: Handler = {
    step: async (cx, m) => {
      if (m.stage === "pick") {
        return { done: ok(s.pr ? { set: { pr: s.pr, head: "a".repeat(40) } } : {}) };
      }
      w.steps++;
      if (s.step === "poll") return { poll: 1 };
      cx.record(m, "work");
      return { spawn: spec() };
    },
    finish: async (cx, m) => {
      await s.finish?.(m, cx);
      return { done: ok() };
    },
  };
  const handlers: Handlers = Object.fromEntries(ORDER.filter((x) => x !== "done").map((x) => [x, h]));
  await p.start({}, { handlers, ...(s.readPr ? { readPr: s.readPr } : {}) });
  return w;
}

const tick = () => new Promise((r) => setTimeout(r, 5));

async function pass(w: World, seconds = 61) {
  const r = await w.p.loop.pass();
  w.p.clock.advance(seconds);
  return r;
}

async function passes(w: World, n: number) {
  for (let i = 0; i < n; i++) await pass(w);
}

async function until(w: World, cond: () => boolean, max = 15) {
  for (let i = 0; i < max && !cond(); i++) await pass(w);
  expect(cond()).toBe(true);
}

const mission = (w: World) =>
  w.p.db.get<Mission>("SELECT * FROM missions WHERE intent = ? ORDER BY id DESC LIMIT 1", A)!;

/** The owner's command, applied on the next pass. */
async function command(w: World, name: "pause" | "resume", text = "") {
  insertCommand(w.p.db, { name, arg: "", text, source: "cli" }, w.p.clock.now());
  await pass(w, 5);
}

async function endChild(w: World, n = 0) {
  w.ends[n]!({ code: 0, signal: null });
  await tick();
}

test("loop: a paused loop does not start the next step of a mission", async () => {
  const w = await world({ step: "poll" });
  await until(w, () => w.steps >= 2);
  await command(w, "pause");
  const before = w.steps;
  await passes(w, 5);
  expect(w.steps).toBe(before);
  expect(mission(w).unclean).toBe(0);
  await command(w, "resume");
  await passes(w, 3);
  expect(w.steps).toBeGreaterThan(before);
});

test("loop: a running step finishes and is applied while paused", async () => {
  const w = await world();
  await until(w, () => w.spawns === 1);
  await command(w, "pause");
  await endChild(w);
  await passes(w, 4);
  const m = mission(w);
  expect(m.stage).toBe("plan");
  expect([m.busy, m.child_pid, m.unclean]).toEqual([0, null, 0]);
  // The next stage is not started.
  expect(w.spawns).toBe(1);
});

test("loop: resume continues missions where they stopped", async () => {
  const w = await world();
  await until(w, () => w.spawns === 1);
  await command(w, "pause");
  await endChild(w);
  await passes(w, 3);
  expect(w.spawns).toBe(1);
  await command(w, "resume");
  await until(w, () => w.spawns === 2);
  expect(mission(w).stage).toBe("plan");
  expect(mission(w).unclean).toBe(0);
});

test("loop: a paused loop makes no GitHub writes", async () => {
  const w = await world({
    finish: async (_m, cx) => {
      await cx.github.commentOnPr("owner/web", 1, "The step is done.");
    },
  });
  const pr = w.p.openOtherPr("web", "other", { "x.txt": "1\n" });
  await until(w, () => w.spawns === 1);
  await command(w, "pause");
  await endChild(w);
  await passes(w, 4);
  // The comment is held, and the result waits for it; nothing failed.
  expect(pr.comments).toHaveLength(0);
  expect(mission(w).stage).toBe("design");
  expect(w.p.db.meta("health")).toBe("[]");
  await command(w, "resume");
  await passes(w, 3);
  expect(pr.comments.map((c) => c.body)).toEqual(["The step is done."]);
  expect(mission(w).stage).toBe("plan");
});

test("loop: polling continues while paused", async () => {
  const reads: number[] = [];
  const w = await world({
    step: "poll",
    pr: 7,
    readPr: async () => {
      reads.push(w.p.clock.now());
      return {
        state: "OPEN",
        mergedAt: null,
        mergeCommit: null,
        head: "a".repeat(40),
        mergeable: "MERGEABLE",
        body: "",
        isDraft: false,
        reviews: [],
        comments: [],
      };
    },
  });
  await until(w, () => reads.length >= 1);
  await command(w, "pause");
  const before = reads.length;
  await passes(w, 4);
  expect(reads.length - before).toBeGreaterThanOrEqual(3);
});

test("loop: held git pushes", async () => {
  const p = new Pipe(TARGET, FILES);
  let held = true;
  const tools = holdPushes(p.tools, () => held);
  p.tools.on("git", () => okResult());
  await expect(tools.run("git", ["push", "origin", "main"])).rejects.toThrow("held while paused");
  expect((await tools.run("git", ["fetch", "origin"])).code).toBe(0);
  held = false;
  expect((await tools.run("git", ["push", "origin", "main"])).code).toBe(0);
});

test("status: paused counts running steps finishing", async () => {
  const w = await world();
  await until(w, () => w.spawns === 1);
  await command(w, "pause");
  const head = (running: number | null) =>
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
  expect(head(4242)).toContain("paused: 1 running steps finishing");
  await endChild(w);
  await passes(w, 2);
  expect(head(4242)).toMatch(/ · paused$/);
});

/** The command line against a scratch home, with its output kept. */
function cli() {
  const intents = bareRepo({ "intents/.keep": "" });
  const dir = tempDir();
  const config = join(dir, "config.toml");
  writeFileSync(
    config,
    `[intents]\nremote = "${intents}"\n\n[github]\napp_id = 1\nme = "owner"\n\n[repos.web]\ngithub = "owner/web"\n`,
  );
  const home = join(dir, "home");
  const o = { out: "", err: "" };
  vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    o.out += String(s);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((s) => {
    o.err += String(s);
    return true;
  });
  const run = (...args: string[]) => main(["--config", config, "--home", home, ...args], new FakeTools());
  return { o, run, db: () => Db.openHome(new Home(home).db) };
}

test("cli: pause now is a command with the now flag", async () => {
  const c = cli();
  try {
    expect(await c.run("pause", "--now")).toBe(0);
    expect(c.o.out).toContain("paused now");
    const db = c.db();
    expect(db.meta("paused")).toBe("1");
    expect(db.meta("paused_now")).toBe("1");
    expect(db.get<{ text: string }>("SELECT text FROM commands ORDER BY id DESC LIMIT 1")?.text).toBe("now");
    // A plain pause later does not carry the flag over.
    expect(await c.run("resume")).toBe(0);
    expect(db.meta("paused_now")).toBeNull();
    expect(await c.run("pause")).toBe(0);
    expect(db.meta("paused_now")).toBeNull();
  } finally {
    vi.restoreAllMocks();
  }
});

test("cli: pause now is refused for one intent", async () => {
  const c = cli();
  try {
    expect(await c.run("pause", "--now", A)).toBe(1);
    expect(c.o.err).toContain("--now stops everything: use it without an intent");
  } finally {
    vi.restoreAllMocks();
  }
});

test("loop: pause now stops running children", async () => {
  const w = await world();
  await until(w, () => w.spawns === 1);
  await command(w, "pause", "now");
  expect(w.p.db.meta("paused_now")).toBe("1");
  await pass(w, 5);
  expect(w.p.tools.kills.filter((k) => k.kind === "work").map((k) => k.signal)).toEqual(["SIGTERM"]);
  await tick();
  await pass(w, 5);
  const m = mission(w);
  expect([m.stage, m.busy, m.child_pid]).toEqual(["design", 0, null]);
  // Everything stopped: the flag is forgotten, the pause stays.
  await pass(w, 5);
  expect(w.p.db.meta("paused_now")).toBeNull();
  expect(w.p.db.meta("paused")).toBe("1");
  expect(w.spawns).toBe(1);
});

test("loop: a child stopped by pause now is not counted as a crash", async () => {
  const w = await world();
  await until(w, () => w.spawns === 1);
  await command(w, "pause", "now");
  await pass(w, 5);
  await tick();
  await pass(w, 5);
  expect(mission(w).unclean).toBe(0);
  await w.p.loop.shutdown();
  await w.p.reopen();
  expect(w.p.logs.some((l) => l.includes("didn't exit cleanly"))).toBe(false);
  expect(mission(w).unclean).toBe(0);
});

test("loop: resume continues the sessions stopped by pause now", async () => {
  const w = await world();
  await until(w, () => w.spawns === 1);
  const session = mission(w).session;
  await command(w, "pause", "now");
  await pass(w, 5);
  await tick();
  await pass(w, 5);
  expect(w.spawns).toBe(1);
  await command(w, "resume");
  await until(w, () => w.spawns === 2);
  expect(mission(w).session).toBe(session);
  expect(mission(w).unclean).toBe(0);
});
