// PIP-112, PIP-113: the plan says how the intent is delivered; a steps plan skips the code PR and
// ends done when the owner ticks its last step.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { applyCommand, insertCommand, tickSteps } from "../../src/commands.ts";
import { dataOf } from "../../src/mission.ts";
import { planBody, planFile } from "../../src/pipeline/prtext.ts";
import { parseResult } from "../../src/pipeline/schemas.ts";
import { parseDelivery, withDelivery } from "../../src/steps.ts";
import { exitsWorld } from "../helpers/exits.ts";
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

const STEP = { when: "before", text: "Turn on the repo setting", why: "only the owner can" };
const BY_HAND = { ...PLAN, delivery: "steps", owner_steps: [STEP] };

test("pipeline: plan.md carries its delivery", () => {
  const md = planFile("T", "261001-0900", ["X-1"], "## Approach\n\nA.", "## Access\n\nNone.", "", "steps");
  expect(md).toMatch(/^# Plan: T\n\nIntent 261001-0900\. Spec IDs: X-1\.\nDelivery: steps\n/);
  expect(parseDelivery(md)).toBe("steps");
  expect(parseDelivery(planFile("T", "i", [], "a", "b"))).toBe("code");
  expect(parseDelivery("no line here")).toBeNull();
  expect(parseDelivery(withDelivery(md, "code"))).toBe("code");
  // A plan from before delivery gets the line under its IDs line.
  expect(withDelivery("# Plan: T\n\nIntent i. No spec change.\n\nbody\n", "steps")).toContain(
    "Intent i. No spec change.\nDelivery: steps\n",
  );
  // The plan PR says it in plain words.
  const links = { intentUrl: null, specPrUrl: null, planPrUrl: null };
  const body = planBody("## Approach\n\nA.", { domains: [], paths: [], tests: [] }, links, "", "", "steps");
  expect(body).toContain("Nothing to build");
  expect(body).not.toContain("the build starts");
});

test("pipeline: a steps plan needs steps the owner can tick", () => {
  expect(parseResult("plan", BY_HAND).ok).toBe(true);
  const none = parseResult("plan", { ...BY_HAND, owner_steps: [] });
  expect(none.ok).toBe(false);
  if (!none.ok) expect(none.why).toMatch(/needs at least one owner_steps entry/);
  expect(parseResult("plan", { ...PLAN, delivery: "later" }).ok).toBe(false);
});

test("pipeline: a plan without delivery counts as code", () => {
  const { delivery: _, ...old } = { ...PLAN, delivery: "code" };
  const r = parseResult("plan", old);
  expect(r.ok && r.value.delivery).toBe("code");
  // And a merged code plan builds, as before.
  const w = exitsWorld();
  w.set({ stage: "approval:plan", waiting: "approve plan", from_stage: "plan" });
  expect(w.move({ event: "plan_merged" }).stage).toBe("build");
});

test("pipeline: a code plan ends as before", () => {
  const w = exitsWorld();
  w.set({ stage: "merge" });
  expect(w.move({ event: "ok" }).stage).toBe("steps");
  // `steps` after a merge (SHIP-19) still goes on to deploy for a code change.
  const s = exitsWorld();
  s.set({ stage: "steps" });
  expect(s.move({ event: "ok" }).stage).toBe("deploy");
  const c = exitsWorld();
  c.set({ stage: "approval:merge", waiting: "review and merge PR", from_stage: "gate" });
  expect(c.move({ event: "code_merged" }).stage).toBe("deploy");
});

describe("a steps plan through the pipeline", () => {
  let p: Pipe;
  beforeAll(async () => {
    p = new Pipe(TARGET, intents(intent({ a: 5 })), { keep: true });
    happy(p);
    p.respond.plan = reply(BY_HAND);
    await p.start();
  }, 30_000);
  afterAll(() => p.cleanup());

  test("pipeline: a steps plan skips build and the code PR", async () => {
    const m = await p.untilStage("steps");
    expect(m.waiting).toBe("your steps");
    expect(p.stages(m.id)).not.toContain("build");
    expect(p.claudeCalls.some((c) => c.kind === "worker")).toBe(false);
    // The spec and the plan PRs exist; there is no code PR.
    expect(p.prs.filter((x) => x.repo === "owner/web")).toHaveLength(1);
    expect(m.pr).toBeNull();
    const plan = p.prs.find((x) => x.repo === "owner/intents")!;
    expect(plan.body).toContain("Nothing to build");
    expect(p.show("intents", "main", `${DIR}/plan.md`)).toContain("Delivery: steps");
    // Steps have no merge: the one listed "before" is asked for after the plan.
    expect(dataOf<{ steps: { when: string }[] }>(m).steps[0]!.when).toBe("after");
  }, 60_000);

  test("pipeline: ticking the last step of a steps plan ends the intent done", async () => {
    const left = tickSteps(p.db, ID, "all", true, new Date(p.clock.now() * 1000));
    expect(left).toContain("no steps left");
    const m = await p.untilStage("done");
    expect(m.stage).toBe("done");
    expect(p.stages(m.id)).not.toContain("deploy");
    await p.loop.pass();
    const done = p.show("intents", "main", `done/${ID}-${SLUG}/intent.md`);
    expect(done).toContain("stage: done");
    // The tick is kept in the plan.
    expect(p.show("intents", "main", `done/${ID}-${SLUG}/plan.md`)).toMatch(
      /- \[x\] after merge: Turn on the repo setting/,
    );
  }, 60_000);
});

describe("switching a change to steps", () => {
  let p: Pipe;
  beforeAll(async () => {
    p = new Pipe(TARGET, intents(intent({ a: 2 })), { keep: true });
    happy(p);
    p.respond.plan = reply({ ...PLAN, owner_steps: [{ ...STEP, when: "after" }] });
    p.script(reply(DESIGN, SPEC));
    await p.start();
  }, 30_000);
  afterAll(() => p.cleanup());

  test("pipeline: switching to steps closes the open code PR and says why", async () => {
    let m = await p.untilStage("approval:spec");
    p.mergePr(p.prNo("web", m.spec_pr!));
    m = await p.untilStage("approval:plan");
    p.mergePr(p.prNo("intents", m.plan_pr!));
    m = await p.untilStage("approval:merge");
    const code = p.prNo("web", m.pr!);
    expect(code.state).toBe("OPEN");
    // The worker asked something while the code PR was open.
    p.db.run(
      "UPDATE missions SET stage = 'blocked', waiting = 'answer the question', from_stage = 'build' WHERE id = ?",
      m.id,
    );
    const row = {
      id: insertCommand(p.db, { name: "steps", arg: ID, source: "cli" }, p.clock.now()),
      name: "steps" as const,
      arg: ID,
      text: "",
      source: "cli",
      created: p.clock.now(),
      applied_at: null,
      result: null,
    };
    const applyCtx = {
      db: p.db,
      now: p.clock.now(),
      subject: () => ({ title: "t", repo: "web", link: null }),
    };
    const r = await applyCommand(
      { db: p.db, store: p.store, applyCtx, now: new Date(p.clock.now() * 1000) },
      row,
    );
    expect(r).toContain("is now steps");
    m = await p.untilStage("steps");
    expect(code.state).toBe("CLOSED");
    expect(code.comments.at(-1)!.body).toBe(
      "Closed: the owner will do this by hand, so there is nothing to merge.",
    );
    expect(m.pr).toBeNull();
    expect(p.show("intents", "main", `${DIR}/plan.md`)).toContain("Delivery: steps");
  }, 90_000);
});
