// Cut-off runs (LOOP-7, LOOP-9): a run killed with Towercab resumes its own session; a session Claude
// no longer has starts fresh with the work's context; a usage limit waits for the reset and resumes
// the same step, on the model that hit it.

import { afterAll, beforeAll, expect, test } from "vitest";
import {
  DESIGN,
  DIR,
  happy,
  ID,
  intent,
  intents,
  PLAN,
  reply,
  SLUG,
  SPEC,
  TARGET,
} from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

let p: Pipe;
const RESET1 = 1_793_010_000;
const RESET2 = 1_793_020_000;

beforeAll(async () => {
  p = new Pipe(TARGET, intents(intent({ a: 5, extra: "model: sonnet\n" })), { keep: true });
  happy(p);
  // What each kind of run does, in order (the tests below follow the flow).
  p.queue("design", () => ({ hang: true }), reply(DESIGN, SPEC));
  p.queue(
    "plan",
    (spec) => {
      const i = spec.argv.indexOf("--resume");
      return {
        code: 1,
        noResult: true,
        stderr: `Error: No conversation found with session ID ${spec.argv[i + 1]}\n`,
      };
    },
    reply(PLAN),
  );
  // The worker (sonnet) and then the review (opus, one above it) hit a usage limit with a reset time.
  const limit = (at: number) => () => ({
    code: 1,
    isError: true,
    result: `Claude AI usage limit reached|${at}`,
  });
  p.queue("worker", limit(RESET1));
  p.queue("review", limit(RESET2));
  await p.start();
}, 30_000);

afterAll(() => p.cleanup());

const calls = (kind: string) => p.claudeCalls.filter((c) => c.kind === kind);

test("loop: resume after kill", async () => {
  // The design run is still going when Towercab is killed.
  await p.until(() => calls("design").length === 1);
  const first = calls("design")[0]!;
  expect(first.session).toEqual({ mode: "new", id: p.mission()!.session });
  await p.reopen();
  expect(p.mission()!.unclean).toBe(1);
  await p.until(() => calls("design").length === 2);
  const again = calls("design")[1]!;
  // Same session, same checkout, picked up where it stopped.
  expect(again.session).toEqual({ mode: "resume", id: first.session.id });
  expect(again.prompt).toBe("Continue where you stopped.");
  expect(again.cwd).toBe(first.cwd);
  await p.untilStage("plan");
}, 30_000);

test("loop: missing session starts fresh", async () => {
  const old = p.mission()!.session;
  expect(await p.until(() => calls("plan").length === 2)).toBeGreaterThan(0);
  const [gone, fresh] = calls("plan");
  expect(gone!.session).toEqual({ mode: "resume", id: old });
  const m = p.mission()!;
  expect(m.session).not.toBe(old);
  expect(fresh!.session).toEqual({ mode: "new", id: m.session });
  // The new session is told where the work is, then gets the step's own task.
  const prompt = fresh!.prompt;
  expect(prompt).toMatch(/^Your earlier session is gone; continue the work from the repo\./);
  expect(prompt).toContain(`Branch: towercab/${ID}-${SLUG}`);
  expect(prompt).toContain(`PR: https://github.com/owner/web/pull/${m.spec_pr}`);
  expect(prompt).toContain(`Intent: https://github.com/owner/intents/blob/main/${DIR}/intent.md`);
  expect(prompt).toContain("Spec IDs: WEB-1");
  expect(prompt).toContain("Plan: none yet");
  expect(prompt).toContain(calls("plan")[0]!.prompt);
  // Later runs resume the new session.
  await p.until(() => calls("worker").length === 1);
  expect(calls("worker")[0]!.session).toEqual({ mode: "resume", id: m.session });
}, 30_000);

test("limits: resume the same step", async () => {
  await p.until(() => p.mission()?.limit_model === "sonnet", 5);
  let m = p.mission()!;
  expect([m.stage, m.step, m.limit_model]).toEqual(["build", "worker", "sonnet"]);
  expect(JSON.parse(p.db.meta("cooldown:sonnet")!).until).toBe(RESET1 + 30);
  // Nothing runs until the reset; it is never a crash, a repair or a timeout.
  for (let i = 0; i < 5; i++) await p.loop.pass();
  expect(calls("worker")).toHaveLength(1);
  m = p.mission()!;
  expect([m.stage, m.step, m.unclean, m.repairs, m.waiting]).toEqual(["build", "worker", 0, 0, null]);
  expect(p.db.all("SELECT * FROM transitions WHERE event IN ('limit', 'timeout', 'crash')")).toEqual([]);
  p.clock.advance(RESET1 + 31 - p.clock.now());
  await p.until(() => calls("worker").length === 2, 5);
  const [cut, resumed] = calls("worker");
  expect(resumed!.prompt).toBe("Continue where you stopped.");
  expect(resumed!.session).toEqual({ mode: "resume", id: cut!.session.id });
  // The first success on sonnet ends its cooldown and backoff.
  await p.until(() => p.mission()?.stage !== "build", 5);
  expect(p.db.meta("cooldown:sonnet")).toBeNull();

  // A review on opus that hits a limit cools opus, not the worker's sonnet, and runs again after.
  await p.until(() => p.mission()?.limit_model === "opus");
  expect(JSON.parse(p.db.meta("cooldown:opus")!).until).toBe(RESET2 + 30);
  expect(p.db.meta("cooldown:sonnet")).toBeNull();
  expect(p.mission()!.stage).toBe("review");
  p.clock.advance(RESET2 + 31 - p.clock.now());
  await p.untilStage("done");
  expect(calls("review").map((c) => c.model)).toEqual(["opus", "opus"]);
  expect(p.db.meta("cooldown:opus")).toBeNull();
}, 30_000);
