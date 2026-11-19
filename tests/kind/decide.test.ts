// PIP-232: kinds change the path, not who decides.

import { expect, test } from "vitest";
import { happy, intent, intents, PLAN, reply, risk, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

function world(kind: string, a: number, extra = ""): Pipe {
  const p = new Pipe(TARGET, intents(intent({ a, extra: `kind: ${kind}\n${extra}` })));
  happy(p);
  if (kind === "infra")
    p.respond.plan = reply({ ...PLAN, apply: [{ command: "true", why: "nothing to change" }] });
  return p;
}

const stagesOf = (p: Pipe): string[] => p.stages(p.mission()!.id);

test("pipeline: a high-risk bugfix is held for the owner", async () => {
  const p = world("bugfix", 5);
  p.respond.risk = () => ({
    structured: risk({ level: "high", summary: "A change to something hard to undo." }),
    cost: 0,
    durationMs: 0,
  });
  try {
    await p.start();
    const m = await p.untilStage("approval:plan");
    expect(m.waiting).toBeTruthy();
    p.clock.advance(3600);
    await p.until(() => true, 3);
    expect(p.mission()!.stage).toBe("approval:plan");
  } finally {
    p.cleanup();
  }
}, 120_000);

test("pipeline: a bugfix has no spec gate and the plan gate still follows autonomy", async () => {
  const p = world("bugfix", 3);
  try {
    await p.start();
    await p.untilStage("approval:plan");
    expect(stagesOf(p)).not.toContain("approval:spec");
    expect(p.mission()!.spec_pr).toBeNull();
    expect(p.moves()).not.toContain("plan_merged");
  } finally {
    p.cleanup();
  }
}, 120_000);

test("pipeline: an a0 intent of any kind waits at every gate it has", async () => {
  const first: Record<string, string> = {
    feature: "approval:spec",
    "spec-only": "approval:spec",
    bugfix: "approval:plan",
    refactor: "approval:plan",
    infra: "approval:plan",
  };
  for (const [kind, stage] of Object.entries(first)) {
    const p = world(kind, 0);
    try {
      await p.start();
      await p.untilStage(stage as "approval:spec" | "approval:plan");
      p.clock.advance(3600);
      await p.until(() => true, 3);
      expect(p.mission()!.stage, kind).toBe(stage);
    } finally {
      p.cleanup();
    }
  }
}, 240_000);

test("pipeline: a kind does not change autonomy", async () => {
  const lowKinds = ["bugfix", "refactor", "infra"];
  for (const kind of lowKinds) {
    const p = world(kind, 5);
    try {
      await p.start();
      await p.until(() => p.moves().includes("plan_merged: a5"));
      expect(p.moves(), kind).toContain("a5, low risk");
    } finally {
      p.cleanup();
    }
  }
  const p = world("bugfix", 2);
  try {
    await p.start();
    await p.untilStage("approval:plan");
    p.clock.advance(3600);
    await p.until(() => true, 3);
    expect(p.mission()!.stage).toBe("approval:plan");
  } finally {
    p.cleanup();
  }
}, 240_000);
