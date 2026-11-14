// PIP-228, PIP-230: each kind runs only the stages its path has; a spec-only design may edit the settings files.

import { expect, test } from "vitest";
import { dataOf } from "../../src/mission.ts";
import { DESIGN, happy, intent, intents, ownerMerges, reply, SPEC, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

function world(kind: string, a = 5): Pipe {
  const p = new Pipe(TARGET, intents(intent({ a, extra: `kind: ${kind}\n` })));
  happy(p);
  return p;
}

const stagesOf = (p: Pipe): string[] => p.stages(p.mission()!.id);

test("pipeline: a bugfix goes from pick to plan with no spec PR", async () => {
  const p = world("bugfix");
  try {
    await p.start();
    await p.untilStage("plan");
    expect(p.mission()!.spec_pr).toBeNull();
    expect(p.moves()).toContain("pick → plan (kind_routed");
    expect(stagesOf(p)).not.toContain("design");
    expect(stagesOf(p)).not.toContain("approval:spec");
    expect(p.claudeCalls.map((c) => c.kind)).not.toContain("design");
  } finally {
    p.cleanup();
  }
}, 120_000);

test("pipeline: a refactor and an infra change skip the spec PR", async () => {
  for (const kind of ["refactor", "infra"]) {
    const p = world(kind);
    try {
      await p.start();
      await p.untilStage("plan");
      expect(p.mission()!.spec_pr, kind).toBeNull();
      expect(stagesOf(p), kind).not.toContain("design");
      expect(
        p.claudeCalls.map((c) => c.kind),
        kind,
      ).not.toContain("design");
    } finally {
      p.cleanup();
    }
  }
}, 120_000);

test("pipeline: a feature keeps the full path", async () => {
  const p = world("feature", 1);
  try {
    await p.start();
    await p.untilStage("approval:spec");
    expect(p.mission()!.spec_pr).not.toBeNull();
    expect(stagesOf(p)).toContain("design");
    expect(p.claudeCalls.map((c) => c.kind)).toContain("design");
  } finally {
    p.cleanup();
  }
}, 120_000);

test("pipeline: a kind never skips ci review or the merge gate", async () => {
  const p = world("bugfix");
  try {
    await p.start();
    const n = await p.until(() => {
      ownerMerges(p);
      return p.mission()?.stage === "done";
    }, 80);
    expect(n, p.moves()).toBeGreaterThan(0);
    const st = stagesOf(p);
    for (const s of ["plan", "build", "verify", "publish", "ci", "review", "gate", "merge"])
      expect(st, s).toContain(s);
    expect(dataOf<{ review: { approved: boolean } }>(p.mission()!).review.approved).toBe(true);
  } finally {
    p.cleanup();
  }
}, 120_000);

const SETTINGS = { "CLAUDE.md": "# Web\n\nUse tabs.\n", "REVIEW.md": "# Review\n\nCheck the greeting.\n" };

test("pipeline: a spec-only design may edit the settings files", async () => {
  const p = world("spec-only", 1);
  p.respond.design = reply(DESIGN, { ...SPEC, ...SETTINGS });
  try {
    await p.start();
    await p.untilStage("approval:spec");
    const branch = `${p.mission()!.branch}-spec`;
    expect(p.show("web", branch, "CLAUDE.md")).toBe(SETTINGS["CLAUDE.md"]);
    expect(p.show("web", branch, "REVIEW.md")).toBe(SETTINGS["REVIEW.md"]);
    const argv = p.claudeCalls.find((c) => c.kind === "design")!.argv;
    expect(argv).toContain("Edit(CLAUDE.md)");
    expect(argv).toContain("Edit(TOWERCAB.md)");
  } finally {
    p.cleanup();
  }
}, 120_000);

test("pipeline: a spec-only design cannot edit code", async () => {
  const p = world("spec-only", 1);
  p.respond.design = reply(DESIGN, { ...SPEC, ...SETTINGS, "src/app.ts": "export {};\n" });
  try {
    await p.start();
    await p.untilStage("approval:spec");
    const branch = `${p.mission()!.branch}-spec`;
    expect(p.show("web", branch, "CLAUDE.md")).toBe(SETTINGS["CLAUDE.md"]);
    expect(() => p.show("web", branch, "src/app.ts")).toThrow();
    // A feature's design gets no settings-file rules at all.
    const f = world("feature", 1);
    try {
      await f.start();
      await f.untilStage("approval:spec");
      const argv = f.claudeCalls.find((c) => c.kind === "design")!.argv;
      expect(argv).not.toContain("Edit(CLAUDE.md)");
    } finally {
      f.cleanup();
    }
  } finally {
    p.cleanup();
  }
}, 120_000);

test("pipeline: a spec-only intent runs no plan or build", async () => {
  const p = world("spec-only", 1);
  try {
    await p.start();
    const n = await p.until(() => {
      ownerMerges(p);
      return p.mission()?.stage === "done";
    }, 80);
    expect(n, p.moves()).toBeGreaterThan(0);
    const kinds = p.claudeCalls.map((c) => c.kind);
    expect(kinds).not.toContain("plan");
    expect(kinds).not.toContain("worker");
    expect(stagesOf(p)).not.toContain("plan");
    expect(stagesOf(p)).not.toContain("build");
    expect(p.mission()!.pr).toBeNull();
  } finally {
    p.cleanup();
  }
}, 120_000);
