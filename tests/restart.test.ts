// One code version at a time (LOOP-105): the loop remembers the commit of the checkout it started from
// and, when the checkout moves, starts nothing new and exits 75 so systemd starts the current code.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { ChildEnd, Ctx, Handler, Handlers, Progress } from "../src/handlers.ts";
import { readHead } from "../src/head.ts";
import { Loop } from "../src/loop.ts";
import { ORDER, ok, wait } from "../src/machine.ts";
import type { Mission } from "../src/mission.ts";
import type { ChildExit, ChildSpec } from "../src/tools.ts";
import { codeCheckout, headOf, moveOn } from "./helpers/code.ts";
import { intent, intents, TARGET } from "./helpers/flows.ts";
import { Pipe } from "./helpers/pipe.ts";
import { git, tempDir } from "./helpers/world.ts";

type Step = (m: Mission, cx: Ctx) => Progress | Promise<Progress>;
type Finish = (m: Mission, end: ChildEnd, cx: Ctx) => Progress | Promise<Progress>;

/** The same fake handler for every working stage. */
function fake(step: Step, finish: Finish = () => ({ done: ok() })): Handlers {
  const h: Handler = { step: async (cx, m) => step(m, cx), finish: async (cx, m, end) => finish(m, end, cx) };
  return Object.fromEntries(ORDER.filter((s) => s !== "done").map((s) => [s, h]));
}

/** A child the test ends by hand. */
function childOf(p: Pipe) {
  let end!: (e: ChildExit) => void;
  const done = new Promise<ChildExit>((r) => {
    end = r;
  });
  p.tools.child("work", () => done);
  const dir = p.home.runs("children");
  const spec: ChildSpec = {
    kind: "work",
    argv: ["work"],
    cwd: dir,
    env: {},
    stdout: join(dir, "work.out"),
    stderr: join(dir, "work.err"),
    slot: true,
  };
  return { spec, end: () => end({ code: 0, signal: null }) };
}

/** A loop whose code is `root`: it records that checkout's commit when it opens. */
async function start(handlers: Handlers, root: string): Promise<Pipe> {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  await p.start({}, { handlers });
  p.loop = new Loop({ ...p.loop.d, codeRoot: root }, { watch: true });
  await p.loop.open();
  return p;
}

test("update: a moved checkout restarts before the next run", async () => {
  const root = codeCheckout();
  const before = headOf(root);
  let steps = 0;
  const p = await start(
    fake(() => {
      steps++;
      return { done: ok() };
    }),
    root,
  );
  // The first pass picks the intent; its step is due in the next one.
  expect((await p.loop.pass()).picked).not.toBeNull();
  p.clock.advance(61);
  const after = moveOn(root);
  const r = await p.loop.pass();
  expect(steps).toBe(0);
  expect(r.stop).toBe(true);
  expect(p.loop.exitCode).toBe(75);
  expect(p.logs.some((l) => l.includes(before) && l.includes(after))).toBe(true);
});

test("update: a HEAD that moves mid-pass restarts before the next run", async () => {
  const root = codeCheckout();
  let work!: ReturnType<typeof childOf>;
  const p = await start(
    fake(() => {
      // The checkout moves after the pass began, while the step prepares its run.
      moveOn(root);
      return { spawn: work.spec };
    }),
    root,
  );
  work = childOf(p);
  expect((await p.loop.pass()).picked).not.toBeNull();
  p.clock.advance(61);
  const r = await p.loop.pass();
  expect(r.stop).toBe(true);
  expect(p.loop.exitCode).toBe(75);
  // The run was dropped before it started, and the mission isn't left marked busy.
  expect(p.tools.spawned.filter((s) => s.kind === "work")).toEqual([]);
  const m = p.mission()!;
  expect([m.child_kind, m.child_pid, m.busy]).toEqual([null, null, 0]);
});

test("update: a run in progress keeps its result across the restart", async () => {
  const root = codeCheckout();
  let work!: ReturnType<typeof childOf>;
  const p = await start(
    fake(
      () => ({ spawn: work.spec }),
      () => ({ done: wait("approve plan") }),
    ),
    root,
  );
  work = childOf(p);
  await p.loop.pass();
  p.clock.advance(61);
  await p.loop.pass();
  expect(p.mission()!.child_kind).toBe("work");
  moveOn(root);
  // The run goes on: the loop waits for it, and nothing new starts.
  p.clock.advance(61);
  const during = await p.loop.pass();
  expect(during.stop).toBe(false);
  expect(p.loop.exitCode).toBe(0);
  work.end();
  await new Promise((r) => setTimeout(r, 5));
  p.clock.advance(61);
  const last = await p.loop.pass();
  // Its result was applied, and then the loop restarted.
  expect(p.mission()!.stage).toBe("approval:plan");
  expect(last.stop).toBe(true);
  expect(p.loop.exitCode).toBe(75);
});

test("head: reads a branch, a packed ref and a detached HEAD", () => {
  const root = codeCheckout();
  const sha = headOf(root);
  expect(readHead(root)).toBe(sha);
  git(root, "pack-refs", "--all");
  expect(readHead(root)).toBe(sha);
  git(root, "checkout", "-q", "--detach");
  expect(readHead(root)).toBe(sha);
  // No checkout, no answer.
  const none = tempDir();
  mkdirSync(join(none, "x"));
  expect(readHead(join(none, "x"))).toBeNull();
});
