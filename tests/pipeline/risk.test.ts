// The risk agent at each gate (PIP-96, PIP-97, PIP-99) and the gates it moves (AUT-9, AUT-11, AUT-12,
// AUT-17..19, AUT-21), through the real pipeline.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { Mission } from "../../src/mission.ts";
import type { PipeData } from "../../src/pipeline/common.ts";
import { DESIGN, happy, intent, intents, ownerMerges, PLAN, reply, risk, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

const data = (m: Mission) => JSON.parse(m.data) as PipeData;

/** The why of every move into a wait, in order. */
function waits(p: Pipe, id: number): [string, string | null][] {
  return p.db
    .all<{ to_stage: string; why: string | null }>(
      "SELECT to_stage, why FROM transitions WHERE mission = ? AND to_stage LIKE 'approval:%' ORDER BY id",
      id,
    )
    .map((t) => [t.to_stage, t.why]);
}

test("pipeline: risk is assessed at each gate", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  happy(p);
  await p.start();
  await p.until(() => p.mission()?.stage === "done");
  const m = p.mission()!;
  expect(m.stage, p.moves()).toBe("done");
  expect(waits(p, m.id)).toEqual([]);
  // Three runs, one per gate, each in a session of its own on the review model: never the worker's.
  const risks = p.claudeCalls.filter((c) => c.kind === "risk");
  const review = p.claudeCalls.find((c) => c.kind === "review")!;
  expect(risks).toHaveLength(3);
  for (const r of risks) {
    expect(r.session.mode).toBe("new");
    expect(r.session.id).not.toBe(m.session);
    expect(r.model).toBe(review.model);
    expect(r.argv.join(" ")).toContain("--tools Read,Glob,Grep,Bash");
  }
  expect(new Set(risks.map((r) => r.session.id)).size).toBe(3);
  expect(risks[0]!.prompt).toContain("You are looking at the spec");
  expect(risks[0]!.prompt).toContain("second reviewer");
  expect(risks[1]!.prompt).toContain("You are looking at the build plan");
  expect(risks[1]!.prompt).toContain("Add a greeting file.");
  expect(risks[2]!.prompt).toContain("You are looking at the code change");
  expect(risks[2]!.prompt).toContain("Approve: small and tested.");
  // Kept per gate, with what it judged.
  const d = data(m);
  expect([d.risk?.spec?.level, d.risk?.plan?.level, d.risk?.code?.level]).toEqual(["low", "low", "low"]);
  // The spec PR's head, the plan's hash, the reviewed diff's patch-id.
  expect(d.riskOf?.spec).toMatch(/^[0-9a-f]{40}$/);
  expect(d.riskOf?.plan).toMatch(/^[0-9a-f]{16}$/);
  expect(d.riskOf?.code).toBe(d.review?.patchId);
  // Their files sit with the stage that ran them (LOOP-39).
  expect(existsSync(join(p.home.runs(m.intent, "design"), "risk-1.json"))).toBe(true);
  expect(existsSync(join(p.home.runs(m.intent, "plan"), "risk-2.json"))).toBe(true);
  expect(existsSync(join(p.home.runs(m.intent, "review"), "risk-3.json"))).toBe(true);
  // Each PR says it, in plain words (PIP-99).
  for (const pr of p.prs) {
    expect(pr.body, pr.title).toContain("## Risk: low");
    expect(pr.body, pr.title).toContain("Easy to undo: Reverting the change puts everything back.");
  }
}, 30_000);

test("autonomy: a4 medium risk waits at spec, plan and merge", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 4 })));
  happy(p);
  p.respond.risk = reply(risk({ level: "medium" }));
  await p.start();
  await p.until(() => {
    ownerMerges(p);
    return p.mission()?.stage === "done";
  });
  const m = p.mission()!;
  expect(m.stage, p.moves()).toBe("done");
  const why = "It is medium risk, and at autonomy a4 only low-risk changes go ahead without you.";
  expect(waits(p, m.id)).toEqual([
    ["approval:spec", why],
    ["approval:plan", why],
    ["approval:merge", why],
  ]);
  expect(p.prs.every((x) => x.body.includes("## Risk: medium"))).toBe(true);
}, 30_000);

test("autonomy: a5 high risk waits for the owner", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  happy(p);
  // Medium at the spec and plan goes ahead at a5; high on the code waits.
  p.queue(
    "risk",
    reply(risk({ level: "medium" })),
    reply(risk({ level: "medium" })),
    reply(risk({ level: "high" })),
  );
  await p.start();
  const m = await p.untilStage("approval:merge");
  expect(waits(p, m.id)).toEqual([
    [
      "approval:merge",
      "It is high risk, and at autonomy a5 low- and medium-risk changes go ahead without you.",
    ],
  ]);
  expect(p.prNo("web", m.pr!).body).toContain("## Risk: high");
}, 30_000);

test("pipeline: open points send the spec to the owner", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  happy(p);
  // The design's concern alone no longer stops the spec: the second reviewer reads it.
  p.respond.design = reply(
    { ...DESIGN, concerns: [{ what: "Greets in English only", why: "The intent names no language." }] },
    { "specs/web.md": "# Web\n\n### WEB-1 · Greeting\n\nThe page says hello.\n" },
  );
  p.queue(
    "risk",
    reply(
      risk({
        open_points: [
          { point: "Should the greeting follow the visitor's language?", why: "The copy depends on it." },
        ],
      }),
    ),
  );
  await p.start();
  const m = await p.untilStage("approval:spec");
  expect([m.waiting, m.why]).toEqual([
    "approve spec",
    "The spec leaves one question for you to settle before it is built.",
  ]);
  const spec = p.prNo("web", m.spec_pr!);
  expect(spec.state).toBe("OPEN");
  expect(spec.body).toContain(
    "## Open points for you\n\n- Should the greeting follow the visitor's language? The copy depends on it.",
  );
  const first = p.claudeCalls.find((c) => c.kind === "risk")!;
  expect(first.prompt).toContain("Greets in English only: The intent names no language.");
  expect(data(m).risk?.spec?.openPoints).toHaveLength(1);
  // The owner merges it; the default answer (no open points) lets the rest go on alone.
  p.mergePr(spec);
  await p.until(() => p.mission()?.stage === "done");
  expect(p.mission()!.stage, p.moves()).toBe("done");
}, 30_000);

test("pipeline: a risk check that doesn't finish leaves the gate to the owner", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  happy(p);
  // No result, twice: the one continue, then no assessment.
  p.queue(
    "risk",
    () => ({ noResult: true }),
    () => ({ noResult: true }),
  );
  await p.start();
  const m = await p.untilStage("approval:spec");
  expect([m.waiting, m.why]).toEqual([
    "approve spec",
    "The risk check didn't finish, so you decide whether it goes ahead.",
  ]);
  expect(data(m).risk?.spec).toBeNull();
  expect(p.prNo("web", m.spec_pr!).body).toContain("The risk check didn't finish");
}, 30_000);

test("pipeline: an intent without a runs as a5", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: null })));
  happy(p);
  await p.start();
  await p.until(() => p.mission()?.stage === "done");
  const m = p.mission()!;
  expect(m.stage, p.moves()).toBe("done");
  expect(waits(p, m.id)).toEqual([]);
  // The plan says what a5 grants.
  expect(p.prs[1]!.title).toMatch(/^docs\(plan\)/);
  expect(p.show("intents", "main", "intents/261026-1000-show-a-greeting/plan.md")).toContain("At a5");
}, 30_000);

test("autonomy: a4 plan asking for protected paths waits", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 4 })));
  happy(p);
  // The risk agent says low; the access the plan asks for makes it medium (AUT-17).
  p.respond.plan = reply({
    ...PLAN,
    access: { domains: [], paths: [{ glob: ".github/workflows/ci.yml", why: "the new job" }], tests: [] },
  });
  await p.start();
  const m = await p.untilStage("approval:plan");
  expect(waits(p, m.id)).toEqual([
    ["approval:plan", "It is medium risk, and at autonomy a4 only low-risk changes go ahead without you."],
  ]);
  const r = data(m).risk?.plan;
  expect([r?.said, r?.level]).toEqual(["low", "medium"]);
  expect(r?.raised).toBe(
    "Raised from low to medium: the plan asks for access beyond the defaults (path: .github/workflows/ci.yml).",
  );
  expect(p.prNo("intents", m.plan_pr!).body).toContain("## Risk: medium");
}, 30_000);

test("pipeline: an answered open point lets the spec go on", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  happy(p);
  p.queue(
    "risk",
    reply(
      risk({ open_points: [{ point: "Greet in the visitor's language?", why: "The copy depends on it." }] }),
    ),
  );
  await p.start();
  const m = await p.untilStage("approval:spec");
  // The owner answers on the spec PR; the design changes nothing, and the second reviewer sees the answer.
  p.ownerComment(p.prNo("web", m.spec_pr!), "English only for now.");
  await p.until(() => p.mission()?.stage === "done");
  const done = p.mission()!;
  expect(done.stage, p.moves()).toBe("done");
  expect(waits(p, done.id)).toEqual([
    ["approval:spec", "The spec leaves one question for you to settle before it is built."],
  ]);
  expect(data(done).specAnswers).toEqual(["English only for now."]);
  const second = p.claudeCalls.filter((c) => c.kind === "risk")[1]!;
  expect(second.prompt).toContain("The owner already decided these on the spec PR");
  expect(second.prompt).toContain("English only for now.");
}, 30_000);

test("pipeline: a retry runs a risk check that didn't finish again", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  happy(p);
  p.queue(
    "risk",
    () => ({ noResult: true }),
    () => ({ noResult: true }),
  );
  await p.start();
  const m = await p.untilStage("approval:spec");
  expect(m.why).toBe("The risk check didn't finish, so you decide whether it goes ahead.");
  p.ownerComment(p.prNo("web", m.spec_pr!), "/retry");
  await p.until(() => p.mission()?.stage === "done");
  const done = p.mission()!;
  expect(done.stage, p.moves()).toBe("done");
  // The same attempt: the check ran again, the design didn't.
  expect([done.id, done.attempt]).toEqual([m.id, 1]);
  expect(p.claudeCalls.filter((c) => c.kind === "design")).toHaveLength(1);
  expect(p.moves()).toContain(
    "approval:spec → design (recheck: the owner asked for the spec risk check again)",
  );
  expect(data(done).risk?.spec?.level).toBe("low");
}, 30_000);
