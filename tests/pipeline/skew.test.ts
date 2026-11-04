// A build whose guard refuses its rules file as another version's (LOOP-106) is never an owner wait: the
// loop restarts and the step runs again, at most 3 times an hour per mission.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { readHead } from "../../src/head.ts";
import { Loop } from "../../src/loop.ts";
import { dataOf, type Mission } from "../../src/mission.ts";
import { GUARD_VERSION } from "../../src/pipeline/guard.ts";
import { codeCheckout, headOf, moveOn } from "../helpers/code.ts";
import { build, CODE, happy, ID, intent, intents, SLUG, TARGET } from "../helpers/flows.ts";
import { blocked, oldLoopWrote } from "../helpers/hook.ts";
import { Pipe } from "../helpers/pipe.ts";

const DONE = ["approval:merge", "done"];
const reached = (p: Pipe) => DONE.includes(p.mission()?.stage ?? "");

async function world(root?: string): Promise<Pipe> {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  happy(p);
  await p.start();
  if (root) {
    p.loop = new Loop({ ...p.loop.d, codeRoot: root }, { watch: true });
    await p.loop.open();
  }
  return p;
}

const stagesOf = (p: Pipe): string[] => p.stages(p.mission()!.id);
const workerCalls = (p: Pipe): number => p.claudeCalls.filter((c) => c.kind === "worker").length;

test("build: version skew restarts and retries the build", async () => {
  // The loop runs from `root`; its checkout moves on while the worker runs, as in the incident.
  const root = codeCheckout();
  const before = headOf(root);
  const p = await world(root);
  let round = 0;
  p.respond.worker = (spec) => {
    round++;
    if (round > 1) return { structured: build(), edits: CODE };
    // An old loop's rules file; every write the worker tries is refused, so it gives up and asks.
    oldLoopWrote(spec);
    moveOn(root);
    return { structured: blocked() };
  };
  await p.until(() => p.loop.exitCode === 75);
  // The loop restarted instead of asking: the mission is still in its build step.
  const m = p.mission()!;
  expect([m.stage, m.waiting], p.moves()).toEqual(["build", null]);
  expect(p.logs.some((l) => l.includes(before) && l.includes("restarting"))).toBe(true);
  // The new process runs the build again, with rules written by the code the hook runs.
  await p.reopen();
  await p.until(() => reached(p), 80);
  expect(workerCalls(p)).toBe(2);
  expect(stagesOf(p)).not.toContain("blocked");
  const rules = JSON.parse(readFileSync(join(p.home.runs(ID, "build"), "guard.json"), "utf8"));
  expect(rules).toMatchObject({ version: GUARD_VERSION, existing: expect.any(Array) });
  const retry = p.db.get<{ why: string }>(
    "SELECT why FROM transitions WHERE mission = ? AND event = 'bad_result'",
    m.id,
  );
  expect(retry?.why).toContain("another version of Towercab");
  expect(dataOf<{ skew?: number[] }>(p.mission()!).skew).toHaveLength(1);
}, 120_000);

test("build: a run refused by skew is redone after the restart", async () => {
  const p = await world();
  let round = 0;
  p.respond.worker = (spec) => {
    round++;
    if (round > 1) return { structured: build(), edits: CODE };
    // The worker managed to write something and says it is done, but the guard refused a write: that run
    // can't be trusted and is thrown away.
    oldLoopWrote(spec);
    return { structured: build({ notes: "from the skewed run" }), edits: { "stale.txt": "x\n" } };
  };
  await p.until(() => reached(p), 80);
  const m = p.mission()!;
  expect(workerCalls(p), p.moves()).toBe(2);
  // The first run made no commit and no PR; its leftovers are gone from the second round.
  const pr = p.pr(`towercab/${ID}-${SLUG}`)!;
  expect(pr).toBeDefined();
  expect(() => p.show("web", pr.head, "stale.txt")).toThrow();
  expect(p.show("web", pr.head, "greeting.txt")).toBe("hello\n");
  expect(stagesOf(p).filter((s) => s === "publish")).toHaveLength(1);
  expect(m.waiting).toBeNull();
}, 120_000);

test("build: a fourth skew in an hour blocks naming both commits and the checkout", async () => {
  // The loop's code is `root`; the hook runs from the checkout of this repo: two different commits.
  const root = codeCheckout();
  const p = await world(root);
  p.respond.worker = (spec) => {
    oldLoopWrote(spec);
    return { structured: blocked() };
  };
  await p.until(() => p.mission()?.stage === "blocked", 120);
  const m: Mission = p.mission()!;
  expect(workerCalls(p), p.moves()).toBe(4);
  expect(m.waiting).toBe("answer the question");
  const hookCheckout = resolve(import.meta.dirname, "..", "..");
  const q = dataOf<{ question: { context: string; question: string } }>(m).question;
  expect(q.context).toContain(headOf(root));
  expect(q.context).toContain(readHead(hookCheckout));
  expect(q.context).toContain(hookCheckout);
  expect(headOf(root)).not.toBe(readHead(hookCheckout));
  // The asked question replaces the worker's own, which said nothing of the cause.
  expect(q.question).not.toContain("regenerate");
  // The retries are over: the count starts again after the owner is asked.
  expect(dataOf<{ skew?: number[] }>(m).skew).toEqual([]);
}, 180_000);

test("build: skews older than an hour do not count", async () => {
  const p = await world();
  let round = 0;
  p.respond.worker = (spec) => {
    round++;
    // The third run takes more than an hour: the first two skews are too old to count against it.
    if (round === 3) p.clock.advance(3700);
    if (round > 5) return { structured: build(), edits: CODE };
    oldLoopWrote(spec);
    return { structured: blocked() };
  };
  await p.until(() => reached(p), 200);
  expect(workerCalls(p), p.moves()).toBe(6);
  expect(stagesOf(p)).not.toContain("blocked");
  expect(existsSync(join(p.home.runs(ID, "build"), "guard-skew.jsonl"))).toBe(false);
}, 240_000);
