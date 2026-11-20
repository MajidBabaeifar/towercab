// The kind's moves in the state machine (INT-77, PIP-228, PIP-230, PIP-231).

import { describe, expect, test } from "vitest";
import { type Next, next, ORDER, type Stage } from "../src/machine.ts";
import { shipFacts } from "../src/steps.ts";

const show = (n: Next) => (n.kind === "go" ? `→ ${n.to}` : n.kind);
const facts = (kind?: string) => shipFacts({ kind });

describe("machine kind", () => {
  test("machine: kind_routed moves pick by kind", () => {
    for (const k of ["bugfix", "refactor", "infra"])
      expect(show(next("pick", "kind_routed", null, facts(k))), k).toBe("→ plan");
    for (const k of ["feature", "spec-only"])
      expect(show(next("pick", "kind_routed", null, facts(k))), k).toBe("→ design");
    expect(show(next("pick", "kind_routed"))).toBe("→ design");
    // The plain `ok` of a mission still at pick carries the same rule.
    expect(show(next("pick", "ok", null, facts("bugfix")))).toBe("→ plan");
    expect(show(next("pick", "ok", null, facts("feature")))).toBe("→ design");
  });

  test("pipeline: a bugfix goes from pick to plan with no spec PR", () => {
    expect(show(next("pick", "kind_routed", null, facts("bugfix")))).toBe("→ plan");
    expect(show(next("plan", "ok", null, facts("bugfix")))).toBe("→ build");
  });

  test("pipeline: a refactor and an infra change skip the spec PR", () => {
    for (const k of ["refactor", "infra"]) {
      const path: Stage[] = ["pick"];
      let at: Stage = "pick";
      for (let i = 0; i < 3; i++) {
        const n: Next = next(at, at === "pick" ? "kind_routed" : "ok", null, facts(k));
        if (n.kind !== "go") break;
        at = n.to;
        path.push(at);
      }
      expect(path, k).toEqual(["pick", "plan", "build", "verify"]);
      expect(path, k).not.toContain("design");
    }
  });

  test("pipeline: a feature keeps the full path", () => {
    let at: Stage = "pick";
    const seen: Stage[] = [at];
    while (at !== "done" && at !== "deploy") {
      const n: Next = next(at, at === "pick" ? "kind_routed" : "ok", null, facts("feature"));
      if (n.kind !== "go") break;
      at = n.to;
      seen.push(at);
    }
    expect(seen).toEqual(ORDER.slice(0, ORDER.indexOf("merge") + 1).concat(["steps", "deploy"] as never));
  });

  test("pipeline: a kind never skips ci review or the merge gate", () => {
    for (const k of ["feature", "bugfix", "refactor", "infra"]) {
      let at: Stage = "plan";
      const seen: Stage[] = [];
      for (let i = 0; i < 12; i++) {
        const n: Next = next(at, "ok", null, facts(k));
        if (n.kind !== "go") break;
        at = n.to;
        seen.push(at);
      }
      for (const s of ["ci", "review", "gate", "merge"] as Stage[]) expect(seen, `${k} ${s}`).toContain(s);
    }
  });

  test("pipeline: merging a spec-only spec PR ends the intent done", () => {
    expect(show(next("approval:spec", "spec_merged", null, facts("spec-only")))).toBe("→ done");
    expect(show(next("design", "spec_merged", null, facts("spec-only")))).toBe("→ done");
    expect(show(next("blocked", "spec_merged", "design", facts("spec-only")))).toBe("→ done");
    // Other kinds still go on to the plan.
    expect(show(next("approval:spec", "spec_merged", null, facts("feature")))).toBe("→ plan");
    expect(show(next("approval:spec", "spec_merged"))).toBe("→ plan");
  });

  test("pipeline: a spec-only intent runs no plan or build", () => {
    expect(show(next("design", "ok", null, facts("spec-only")))).toBe("→ done");
    expect(show(next("design", "ok", null, facts("feature")))).toBe("→ plan");
  });

  test("machine: a kind change moves a mission only to a stage it still needs", () => {
    // Lighter before the plan: the spec PR is skipped.
    expect(show(next("design", "kind_routed", null, facts("bugfix")))).toBe("→ plan");
    expect(show(next("approval:spec", "kind_routed", "design", facts("infra")))).toBe("→ plan");
    expect(show(next("blocked", "kind_routed", "design", facts("refactor")))).toBe("→ plan");
    // Lighter from the plan on: nothing moves.
    for (const s of ["plan", "approval:plan", "build", "verify", "ci", "approval:merge"] as Stage[])
      expect(show(next(s, "kind_routed", s.startsWith("approval") ? "gate" : null, facts("bugfix"))), s).toBe(
        "ignore",
      );
    // Feature from the plan on: back to design.
    for (const s of ["plan", "build", "proof", "review", "merge"] as Stage[])
      expect(show(next(s, "kind_routed", null, facts("feature"))), s).toBe("→ design");
    expect(show(next("approval:plan", "kind_routed", "plan", facts("feature")))).toBe("→ design");
    expect(show(next("blocked", "kind_routed", "build", facts("feature")))).toBe("→ design");
    // Already at design as a feature: no move. After the merge nothing moves.
    expect(show(next("design", "kind_routed", null, facts("feature")))).toBe("ignore");
    for (const s of ["deploy", "e2e", "rollback", "done", "stopped"] as Stage[])
      expect(show(next(s, "kind_routed", null, facts("feature"))), s).toBe("ignore");
  });
});
