// LOOP-136, LOOP-137, LOOP-2: stopping does not wait for a hanging `gh` or `git` call, and the next
// start finds nothing to recover.

import { expect, test, vi } from "vitest";
import type { Ctx, Handler, Handlers, Progress } from "../src/handlers.ts";
import { ORDER, ok } from "../src/machine.ts";
import type { Mission } from "../src/mission.ts";
import { unitText } from "../src/service.ts";
import { KILL_AFTER_MS, realTools } from "../src/tools.ts";
import { intent, TARGET } from "./helpers/flows.ts";
import { Pipe } from "./helpers/pipe.ts";
import { okResult } from "./helpers/tools.ts";

const A = "261026-1000";
const B = "261026-1001";
const GRACE_MS = 50;

type Step = (m: Mission, cx: Ctx) => Progress | Promise<Progress>;

function fake(step: Step): Handlers {
  const h: Handler = {
    step: async (cx, m) => step(m, cx),
    finish: async () => ({ done: ok() }),
  };
  return Object.fromEntries(ORDER.filter((s) => s !== "done").map((s) => [s, h]));
}

function files(...ids: string[]) {
  return Object.fromEntries(
    ids.map((id) => [
      `intents/${id}-t${id.slice(-1)}/intent.md`,
      intent({ title: `T${id.slice(-1)}`, repo: "web", u: 4, i: 4, extra: "" }),
    ]),
  );
}

/** Let the loop's own timers and the fakes' promises run. */
async function until(done: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error("never happened");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** The loop's grace period, shortened so a test needs no real 10 s. */
function shortGrace(p: Pipe): void {
  (p.loop as unknown as { d: { stopGraceMs?: number } }).d.stopGraceMs = GRACE_MS;
}

/**
 * A mission whose step calls `cmd`; once `hang` is set that call never returns. The loop is stopped
 * while it hangs, as `run` does on SIGTERM.
 */
async function stopWhileHung(cmd: "gh" | "git") {
  const p = new Pipe(TARGET, files(A));
  let steps = 0;
  let hang = false;
  let hung = 0;
  const real = realTools();
  const answer = (args: string[]) => {
    if (args[0] === "hang-me") {
      hung++;
      return new Promise<never>(() => {});
    }
    return null;
  };
  p.tools.on("gh", (args) => answer(args) ?? okResult());
  p.tools.on("git", (args, opts) => answer(args) ?? real.run("git", args, opts));
  await p.start(
    {},
    {
      handlers: fake(async (m, cx) => {
        if (m.stage === "pick") return { done: ok() };
        steps++;
        cx.record(m, "work");
        const r = await cx.tools.run(cmd, [hang ? "hang-me" : "ok"], { cwd: cx.home.root });
        if (r.code !== 0) throw new Error(r.stderr.trim());
        return { poll: 1 };
      }),
    },
  );
  for (let i = 0; i < 8 && steps === 0; i++) {
    await p.loop.pass();
    p.clock.advance(61);
  }
  expect(steps).toBeGreaterThan(0);
  const before = steps;
  shortGrace(p);
  hang = true;
  // The loop is already open; `run` is the loop a SIGTERM stops.
  p.loop.open = async () => {};
  const t0 = Date.now();
  const run = p.loop.run();
  await until(() => hung > 0);
  p.loop.stop(0);
  const code = await run;
  return {
    p,
    code,
    ms: Date.now() - t0,
    before,
    steps: () => steps,
    unhang: () => {
      hang = false;
    },
  };
}

async function killedAfterGrace(cmd: "gh" | "git") {
  const { p, code, ms } = await stopWhileHung(cmd);
  expect(code).toBe(0);
  // Well inside the 60 s of the unit: the call is cut off at the grace period, not waited for.
  expect(ms).toBeLessThan(5000);
  expect(p.db.meta("running")).toBeNull();
}

test("shutdown: a gh call that never exits is killed after the grace period", () => killedAfterGrace("gh"));

test("shutdown: a git call that never exits is killed after the grace period", () => killedAfterGrace("git"));

test("shutdown: a cut-off call does not count as a failure", async () => {
  const { p, before, steps, unhang } = await stopWhileHung("gh");
  const m = p.mission()!;
  expect([m.stage, m.busy, m.unclean]).toEqual(["design", 0, 0]);
  expect(p.moves()).not.toMatch(/crash/);
  // The step is entered again at the next start.
  unhang();
  await p.reopen();
  await p.loop.pass();
  expect(steps()).toBeGreaterThan(before);
  expect(p.mission()!.stage).toBe("design");
});

test("shutdown: the next start after a cut-off call reports a clean exit", async () => {
  const { p } = await stopWhileHung("gh");
  expect(p.db.meta("running")).toBeNull();
  p.logs.length = 0;
  await p.reopen();
  expect(p.logs.some((l) => l.includes("didn't exit cleanly"))).toBe(false);
  expect(p.mission()!.unclean).toBe(0);
});

test("shutdown: the stop logs the calls it cut off", async () => {
  const { p } = await stopWhileHung("gh");
  expect(p.logs).toContain(`stop: cut off gh hang-me after ${GRACE_MS / 1000}s`);
});

test("shutdown: no new work starts once stopping", async () => {
  const p = new Pipe(TARGET, files(A));
  let steps = 0;
  await p.start(
    {},
    {
      handlers: fake(() => {
        steps++;
        return { done: ok() };
      }),
    },
  );
  p.loop.stop(0);
  const r = await p.loop.pass();
  expect(r.stop).toBe(true);
  expect(r.picked).toBeNull();
  expect(steps).toBe(0);
  expect(p.mission()).toBeUndefined();
  await p.loop.shutdown();
});

test("shutdown: children are stopped together", async () => {
  const p = new Pipe(TARGET, files(A, B));
  const ends = new Map<string, () => void>();
  for (const kind of ["work-a", "work-b"]) {
    p.tools.child(kind, () => new Promise((r) => ends.set(kind, () => r({ code: 0, signal: null }))));
    p.tools.stubborn.add(kind);
  }
  const dir = () => p.home.runs("children");
  await p.start(
    { agent: { parallel: 2 } },
    {
      handlers: fake((m) => {
        if (m.stage === "pick") return { done: ok() };
        const kind = m.intent === A ? "work-a" : "work-b";
        return {
          spawn: {
            kind,
            argv: [kind],
            cwd: dir(),
            env: {},
            stdout: `${dir()}/${kind}.out`,
            stderr: `${dir()}/${kind}.err`,
            slot: true,
          },
        };
      }),
    },
  );
  for (let i = 0; i < 10 && ends.size < 2; i++) {
    await p.loop.pass();
    p.clock.advance(61);
  }
  expect(ends.size).toBe(2);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    p.loop.stop(0);
    const down = p.loop.shutdown();
    await vi.advanceTimersByTimeAsync(0);
    // Both got SIGTERM before either was waited for.
    const work = () => p.tools.kills.filter((k) => k.kind.startsWith("work-"));
    expect(
      work()
        .map((k) => `${k.kind} ${k.signal}`)
        .sort(),
    ).toEqual(["work-a SIGTERM", "work-b SIGTERM"]);
    await vi.advanceTimersByTimeAsync(KILL_AFTER_MS);
    await down;
    expect(
      work()
        .filter((k) => k.signal === "SIGKILL")
        .map((k) => k.kind)
        .sort(),
    ).toEqual(["work-a", "work-b"]);
  } finally {
    vi.useRealTimers();
  }
  expect(p.db.meta("running")).toBeNull();
});

test("service: the unit gives a stop 60 s", () => {
  expect(unitText("/home/o/towercab", "/n")).toContain("TimeoutStopSec=60\n");
});
