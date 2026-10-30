// Autonomy (AUT-3, 4, 7, 8, 9, 11..15, 18, 19): effective `a`, the gates, lowering, access by level.

import { expect, test } from "vitest";
import {
  accessPolicy,
  effectiveA,
  type GateInput,
  gate,
  lowered,
  planGate,
  riskWaits,
  specGate,
} from "../src/autonomy.ts";
import { grantsFor } from "../src/pipeline/access.ts";

const approved = { approved: true };
const base: GateInput = {
  a: 4,
  ciGreen: true,
  review: approved,
  unplanned: false,
  proven: true,
  risk: "low",
};
const decide = (o: Partial<GateInput>) => gate({ ...base, ...o });

test("autonomy: gate table", () => {
  // a4 with every check passed and low risk: Towercab merges (AUT-4); a5 too.
  expect(decide({})).toEqual({ merge: true });
  expect(decide({ a: 5 })).toEqual({ merge: true });
  // a1–a3: the owner merges, even with everything green and low risk (AUT-3).
  for (const a of [1, 2, 3])
    expect(decide({ a })).toEqual({
      merge: false,
      why: `At autonomy a${a} you merge every change yourself.`,
    });
  // First match wins, in PIP-7's order.
  const all: Partial<GateInput> = {
    a: 3,
    ciGreen: false,
    review: { approved: false },
    unplanned: true,
    proven: false,
    risk: "high",
  };
  expect(decide(all)).toEqual({ merge: false, why: "GitHub's automatic checks haven't passed." });
  expect(decide({ ...all, ciGreen: true })).toEqual({
    merge: false,
    why: "The independent code review didn't approve it, even after fix rounds.",
  });
  expect(decide({ ...all, ciGreen: true, review: null })).toEqual({
    merge: false,
    why: "The independent code review didn't finish.",
  });
  expect(decide({ ...all, a: 4, ciGreen: true, review: approved })).toEqual({
    merge: false,
    why: "The agent needed access the approved plan didn't grant.",
  });
  // Unplanned access holds only at a4: at a1–a3 the owner merges anyway, a5 needs none.
  expect(decide({ ...all, ciGreen: true, review: approved })).toEqual({
    merge: false,
    why: "No test shows that the change works: none fails without it.",
  });
  expect(decide({ unplanned: true, a: 5 })).toEqual({ merge: true });
  expect(decide({ proven: false })).toEqual({
    merge: false,
    why: "No test shows that the change works: none fails without it.",
  });
  expect(decide({ ...all, ciGreen: true, review: approved, unplanned: false, proven: true })).toEqual({
    merge: false,
    why: "At autonomy a3 you merge every change yourself.",
  });
});

test("autonomy: risk decides the gates at a4 and a5", () => {
  // a4: only low risk goes ahead; a5: low and medium go ahead, high waits.
  expect(riskWaits(4, "low")).toBe(false);
  expect(riskWaits(4, "medium")).toBe(true);
  expect(riskWaits(4, "high")).toBe(true);
  expect(riskWaits(5, "low")).toBe(false);
  expect(riskWaits(5, "medium")).toBe(false);
  expect(riskWaits(5, "high")).toBe(true);
  // The code gate.
  expect(decide({ risk: "medium" })).toEqual({
    merge: false,
    why: "It is medium risk, and at autonomy a4 only low-risk changes go ahead without you.",
  });
  expect(decide({ a: 5, risk: "medium" })).toEqual({ merge: true });
  expect(decide({ a: 5, risk: "high" })).toEqual({
    merge: false,
    why: "It is high risk, and at autonomy a5 low- and medium-risk changes go ahead without you.",
  });
  // The plan gate: a1–a3 always the owner; a4 and a5 by risk.
  for (const a of [1, 2, 3]) expect(planGate(a, "low")).toBe(true);
  expect(planGate(4, "low")).toBe(false);
  expect(planGate(4, "medium")).toBe(true);
  expect(planGate(5, "medium")).toBe(false);
  expect(planGate(5, "high")).toBe(true);
});

test("autonomy: no risk assessment goes to the owner", () => {
  expect(riskWaits(5, null)).toBe(true);
  expect(decide({ a: 5, risk: null })).toEqual({
    merge: false,
    why: "The risk check didn't finish, so you decide whether it goes ahead.",
  });
  expect(planGate(5, null)).toBe(true);
  expect(specGate(5, 0, null)).toBe(true);
});

test("autonomy: no a counts as a5", () => {
  expect(effectiveA(null, null, 5, "me")).toBe(5);
  expect(effectiveA(null, null, 5, null)).toBe(5);
  // The repo cap and AUT-13 still apply.
  expect(effectiveA(null, null, 3, "me")).toBe(3);
  expect(effectiveA(null, null, 5, "github:issue#12")).toBe(4);
  // An `a` present still counts, so removing it mid-flight can't loosen a gate.
  expect(effectiveA(2, null, 5, "me")).toBe(2);
});

test("autonomy: repo cap", () => {
  expect(effectiveA(5, 5, 5, "me")).toBe(5);
  expect(effectiveA(5, 4, 5, "me")).toBe(4);
  expect(effectiveA(4, 5, 5, "me")).toBe(4);
  expect(effectiveA(5, 5, 3, "me")).toBe(3);
  // Removing `a` mid-flight can't loosen a gate: the one present counts.
  expect(effectiveA(2, null, 5, "me")).toBe(2);
  expect(effectiveA(null, 2, 5, "me")).toBe(2);
  expect(effectiveA(5, null, 1, null)).toBe(1);
});

test("autonomy: a5 needs source me", () => {
  expect(effectiveA(5, 5, 5, "me")).toBe(5);
  expect(effectiveA(5, 5, 5, null)).toBe(5);
  expect(effectiveA(5, 5, 5, "github:issue#12")).toBe(4);
  expect(effectiveA(3, 5, 5, "alert")).toBe(3);
  expect(
    grantsFor({ a: 5, source: "alert", plan: null, unlock: [], network: [], defaults: [], unplanned: null })
      .open,
  ).toBe(false);
});

test("autonomy: spec gate", () => {
  // true = the owner merges the spec PR.
  expect(specGate(1, 0, "low")).toBe(true);
  expect(specGate(2, 0, "low")).toBe(true);
  expect(specGate(3, 0, "low")).toBe(false);
  expect(specGate(5, 0, "low")).toBe(false);
  // Open points from the second reviewer always go to the owner (PIP-97).
  expect(specGate(5, 1, "low")).toBe(true);
  // Risk: a3 and a4 wait on medium and high, a5 only on high.
  expect(specGate(3, 0, "medium")).toBe(true);
  expect(specGate(4, 0, "medium")).toBe(true);
  expect(specGate(5, 0, "medium")).toBe(false);
  expect(specGate(5, 0, "high")).toBe(true);
});

test("autonomy: plan gate", () => {
  for (const a of [1, 2, 3]) expect(planGate(a, "low")).toBe(true);
  expect(planGate(4, "low")).toBe(false);
  expect(planGate(5, "low")).toBe(false);
  expect(planGate(4, "high")).toBe(true);
});

test("autonomy: a worker only lowers a", () => {
  expect(lowered(4, 2)).toBe(2);
  expect(lowered(4, 4)).toBeNull();
  expect(lowered(2, 3)).toBeNull();
  expect(lowered(4, null)).toBeNull();
  expect(lowered(4, 0)).toBeNull();
  expect(lowered(5, 6)).toBeNull();
  expect(lowered(5, 2.5)).toBeNull();
  // No `a` counts as a5 (AUT-9): anything below it.
  expect(lowered(null, 3)).toBe(3);
  expect(lowered(null, 4)).toBe(4);
  expect(lowered(null, 5)).toBeNull();
});

test("autonomy: access by level", () => {
  expect(accessPolicy(2)).toEqual({ network: "list", protectedPaths: "writable", request: "granted" });
  expect(accessPolicy(4)).toEqual({ network: "list", protectedPaths: "planned", request: "owner merges" });
  expect(accessPolicy(5)).toEqual({ network: "open", protectedPaths: "writable", request: "not needed" });

  const input = {
    source: "me",
    plan: {
      domains: [{ domain: "api.stripe.com", why: "docs" }],
      paths: [{ glob: ".github/workflows/ci.yml", why: "ci" }],
    },
    unlock: ["migrations/**"],
    network: ["pkg.go.dev"],
    defaults: ["registry.npmjs.org", "*.npmjs.org"],
    unplanned: {
      domains: [{ domain: "example.com", why: "spec" }],
      paths: [{ glob: "ops/**", why: "deploy" }],
    },
  };
  const domains = ["registry.npmjs.org", "*.npmjs.org", "api.stripe.com", "pkg.go.dev", "example.com"];
  // a1–a3: the list, the plan and requests; every protected path but .git.
  expect(grantsFor({ ...input, a: 3 })).toEqual({ domains, paths: ["**"], open: false });
  // a4: protected paths only as planned (plus the intent's unlock and mid-build grants).
  expect(grantsFor({ ...input, a: 4 })).toEqual({
    domains,
    paths: [".github/workflows/ci.yml", "migrations/**", "ops/**"],
    open: false,
  });
  expect(grantsFor({ ...input, a: 4, plan: null, unplanned: null, unlock: [] }).paths).toEqual([]);
  // a5: open network, everything writable.
  expect(grantsFor({ ...input, a: 5 })).toMatchObject({ paths: ["**"], open: true });
});
