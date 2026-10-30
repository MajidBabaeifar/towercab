// The red→green proof (PIP-30): tests that also pass on base prove nothing, so the worker gets repair
// rounds; after them the owner decides, and an unproven change then goes to the owner at the gate.

import { afterAll, beforeAll, expect, test } from "vitest";
import { build, happy, intent, intents, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

let p: Pipe;

beforeAll(async () => {
  p = new Pipe(TARGET, intents(intent({ a: 5 })), { keep: true });
  happy(p);
  let round = 0;
  // Every round adds a test that passes with or without the change.
  p.respond.worker = () => {
    round++;
    return {
      structured: build(),
      edits: { "greeting.txt": `hello ${round}\n`, [`tests/always-${round}.sh`]: "true\n" },
    };
  };
  await p.start();
}, 30_000);

afterAll(() => p.cleanup());

test("pipeline: green on base repairs", async () => {
  const m = await p.untilStage("blocked");
  expect([m.waiting, m.why], p.moves()).toEqual([
    "tests don't prove the change",
    "The PR's tests pass without the change, so they don't prove it.",
  ]);
  const reds = p.db.all<{ from_stage: string; to_stage: string; why: string }>(
    "SELECT from_stage, to_stage, why FROM transitions WHERE event = 'red' ORDER BY id",
  );
  expect(reds).toEqual([
    { from_stage: "proof", to_stage: "build", why: "no test fails without the change" },
    { from_stage: "proof", to_stage: "build", why: "no test fails without the change" },
  ]);
  const repairs = p.claudeCalls.filter((c) => c.kind === "worker").slice(1);
  expect(repairs).toHaveLength(2);
  for (const r of repairs) {
    expect(r.prompt).toMatch(/^No test fails without your change\./);
    // It says what the proof ran on base, and what to do when those commands can't run the test.
    expect(r.prompt).toContain("runs the base's checks there:\n\n    sh -c 'for t in tests/*.sh;");
    expect(r.prompt).toContain("return status blocked with a question for the owner.");
  }
  // The proof laid the PR's own tests over base: base has no greeting.txt, yet they passed.
  const proofs = p.sandboxRuns.filter((r) => r.kind === "proof");
  expect(proofs).toHaveLength(3);
  expect(proofs.every((r) => r.cwd.endsWith("-proof"))).toBe(true);
  expect(m.pr).toBeNull();
}, 30_000);

test("pipeline: unproven goes to the owner", async () => {
  const m = p.mission()!;
  p.ownerComment(p.prNo("intents", m.plan_pr!), "Fine, the change is too small to test. Go on.");
  p.clock.advance(61);
  const at = await p.untilStage("approval:merge");
  expect(at.why).toBe("No test shows that the change works: none fails without it.");
  expect(at.waiting).toBe("review and merge PR");
  expect(JSON.parse(at.data)).toMatchObject({ unproven: true, proof: "not proven" });
  // Checks, CI and the review all passed; only the proof sends it to the owner.
  expect(p.prNo("web", at.pr!).body).toContain("- Test proof: no test fails without the change");
  expect(p.prNo("web", at.pr!).body).toContain("- Review: approved");
  const after = p.db.all<{ from_stage: string; event: string; to_stage: string }>(
    "SELECT from_stage, event, to_stage FROM transitions WHERE mission = ? ORDER BY id",
    at.id,
  );
  expect(after.slice(-8).map((t) => `${t.from_stage}>${t.to_stage}`)).toEqual([
    "blocked>build",
    "build>verify",
    "verify>proof",
    "proof>publish",
    "publish>ci",
    "ci>review",
    "review>gate",
    "gate>approval:merge",
  ]);
}, 30_000);
