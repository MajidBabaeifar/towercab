// A block that Towercab's own logs trace to a known setup error is retried once before the owner is asked
// (LOOP-107); a block of the work's own, or one only the worker's account calls a setup fault, is not.

import { expect, test } from "vitest";
import { dataOf } from "../../src/mission.ts";
import { SETUP_FAULTS } from "../../src/pipeline/setup-faults.ts";
import { build, CODE, happy, intent, intents, TARGET } from "../helpers/flows.ts";
import { blocked, guardRefused, QUESTION } from "../helpers/hook.ts";
import { Pipe } from "../helpers/pipe.ts";

const DONE = ["approval:merge", "done"];

/** The reason the hook logs when it fails closed on a rules file the loop wrote. */
const MALFORMED = "guard: /runs/build/guard.json: existing missing: blocked";

async function world(): Promise<Pipe> {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  happy(p);
  await p.start();
  return p;
}

const workerCalls = (p: Pipe): number => p.claudeCalls.filter((c) => c.kind === "worker").length;
const stagesOf = (p: Pipe): string[] => p.stages(p.mission()!.id);

test("loop: a setup block is retried once", async () => {
  const p = await world();
  let round = 0;
  p.respond.worker = (spec) => {
    round++;
    if (round > 1) return { structured: build(), edits: CODE };
    guardRefused(spec, MALFORMED);
    return { structured: blocked() };
  };
  await p.until(() => DONE.includes(p.mission()?.stage ?? ""), 80);
  const m = p.mission()!;
  expect(workerCalls(p), p.moves()).toBe(2);
  // No wait, no message: the step simply ran again, and the move log says why.
  expect(stagesOf(p)).not.toContain("blocked");
  const retry = p.db.get<{ from_stage: string; to_stage: string; why: string }>(
    "SELECT from_stage, to_stage, why FROM transitions WHERE mission = ? AND event = 'bad_result'",
    m.id,
  );
  expect(retry).toMatchObject({ from_stage: "build", to_stage: "build" });
  expect(retry!.why).toContain("guard-rules-malformed");
  expect(Object.values(dataOf<{ setupRetried?: Record<string, boolean> }>(m).setupRetried ?? {})).toEqual([
    true,
  ]);
  expect(p.db.all("SELECT 1 FROM outbox WHERE mission = ?", m.id)).toEqual([]);
}, 120_000);

test("loop: a sandbox that does not start is retried once", async () => {
  const p = await world();
  let round = 0;
  p.respond.worker = () => {
    round++;
    if (round > 1) return { structured: build(), edits: CODE };
    // The sandbox's own output, in the run's stderr file; the worker's answer says nothing of it.
    return { structured: blocked(), stderr: "bwrap: setting up uid map: Permission denied\n" };
  };
  await p.until(() => DONE.includes(p.mission()?.stage ?? ""), 80);
  expect(workerCalls(p), p.moves()).toBe(2);
  expect(stagesOf(p)).not.toContain("blocked");
}, 120_000);

test("loop: a second setup block waits for the owner", async () => {
  const p = await world();
  p.respond.worker = (spec) => {
    guardRefused(spec, MALFORMED);
    return { structured: blocked() };
  };
  await p.until(() => p.mission()?.stage === "blocked", 80);
  const m = p.mission()!;
  expect(workerCalls(p), p.moves()).toBe(2);
  expect(m.waiting).toBe("answer the question");
  // The owner reads the cause in plain words, then the worker's own question.
  const q = dataOf<{ question: { context: string; question: string } }>(m).question;
  expect(q.context).toContain("failed again after one automatic retry");
  expect(q.context).toContain(SETUP_FAULTS.find((f) => f.id === "guard-rules-malformed")!.plain);
  expect(q.context).toContain(QUESTION.context);
  expect(q.question).toBe(QUESTION.question);
}, 120_000);

test("loop: a block caused by the work is not retried", async () => {
  // The hook refused a protected path: the work needs the owner, not a second try.
  const protectedPath = await world();
  protectedPath.respond.worker = (spec) => {
    guardRefused(
      spec,
      "CLAUDE.md is protected: if you need it, finish what you can and return status access with this path and why",
    );
    return { structured: blocked() };
  };
  await protectedPath.until(() => protectedPath.mission()?.stage === "blocked", 80);
  expect(workerCalls(protectedPath), protectedPath.moves()).toBe(1);
  expect(dataOf(protectedPath.mission()!).setupRetried).toBeUndefined();

  // The worker is stuck on something of its own, with nothing wrong in Towercab's logs.
  const stuck = await world();
  stuck.respond.worker = () => ({ structured: blocked() });
  await stuck.until(() => stuck.mission()?.stage === "blocked", 80);
  expect(workerCalls(stuck), stuck.moves()).toBe(1);
  expect(dataOf<{ question: { context: string } }>(stuck.mission()!).question.context).toBe(QUESTION.context);
}, 180_000);

test("loop: only a listed setup error is retried", async () => {
  const p = await world();
  p.respond.worker = (spec) => {
    // The guard refused for a reason no entry of the list names, and the run's stderr says something else.
    guardRefused(spec, "guard: the disk is full: blocked");
    return { structured: blocked(), stderr: "warning: something odd happened\n" };
  };
  await p.until(() => p.mission()?.stage === "blocked", 80);
  expect(workerCalls(p), p.moves()).toBe(1);
  expect(dataOf(p.mission()!).setupRetried).toBeUndefined();
}, 120_000);

test("loop: the agent's account of a block does not make it a setup fault", async () => {
  const p = await world();
  p.respond.worker = () => ({
    // The worker says the sandbox and the guard are broken; Towercab's logs show nothing of the kind.
    structured: blocked({
      question: {
        ...QUESTION,
        context:
          "bwrap: setting up uid map: Permission denied. The sandbox is broken and the guard refuses every write.",
      },
    }),
    result: "bwrap: setting up uid map: Permission denied",
  });
  await p.until(() => p.mission()?.stage === "blocked", 80);
  expect(workerCalls(p), p.moves()).toBe(1);
  expect(dataOf(p.mission()!).setupRetried).toBeUndefined();
}, 120_000);
