// Autonomy (AUT-3, 4, 7, 8, 9, 11..15): effective `a`, the gates, lowering, access by level.

import { expect, test } from "vitest";
import {
  accessPolicy,
  effectiveA,
  type GateInput,
  gate,
  lowered,
  planGate,
  specGate,
} from "../src/autonomy.ts";
import { grantsFor } from "../src/pipeline/access.ts";

const approved = { approved: true, door: "two-way" as const, redLines: false };
const base: GateInput = { a: 4, cap: 5, ciGreen: true, review: approved, unplanned: false, proven: true };
const decide = (o: Partial<GateInput>) => gate({ ...base, ...o });

test("autonomy: gate table", () => {
  // a4 with every check passed: Towercab merges (AUT-4); a5 too.
  expect(decide({})).toEqual({ merge: true });
  expect(decide({ a: 5 })).toEqual({ merge: true });
  // a1–a3: the owner merges, even with everything green (AUT-3).
  for (const a of [1, 2, 3])
    expect(decide({ a })).toEqual({ merge: false, why: `autonomy a${a}: the owner merges` });
  // First match wins, in PIP-7's order.
  const all: Partial<GateInput> = {
    a: 3,
    ciGreen: false,
    review: { ...approved, approved: false },
    unplanned: true,
    proven: false,
  };
  expect(decide(all)).toEqual({ merge: false, why: "CI not green" });
  expect(decide({ ...all, ciGreen: true })).toEqual({ merge: false, why: "review not approved" });
  expect(decide({ ...all, ciGreen: true, review: null })).toEqual({
    merge: false,
    why: "review not approved",
  });
  expect(decide({ ...all, a: 4, ciGreen: true, review: approved })).toEqual({
    merge: false,
    why: "access beyond the plan",
  });
  // Unplanned access holds only at a4 or with no a: at a1–a3 the owner merges anyway, a5 needs none.
  expect(decide({ ...all, ciGreen: true, review: approved })).toEqual({
    merge: false,
    why: "no test fails without the change",
  });
  expect(decide({ unplanned: true, a: 5 })).toEqual({ merge: true });
  expect(decide({ unplanned: true, a: null })).toEqual({ merge: false, why: "access beyond the plan" });
  expect(decide({ proven: false })).toEqual({ merge: false, why: "no test fails without the change" });
  // No `a` (AUT-9): low-risk merges under a cap of 4 or more.
  expect(decide({ a: null })).toEqual({ merge: true });
  expect(decide({ a: null, review: { ...approved, door: "one-way" } })).toEqual({
    merge: false,
    why: "no autonomy set and the change isn't low-risk",
  });
  expect(decide({ a: null, review: { ...approved, redLines: true } }).merge).toBe(false);
});

test("autonomy: no a goes to the owner under the cap", () => {
  for (const cap of [1, 2, 3]) {
    expect(decide({ a: null, cap })).toEqual({
      merge: false,
      why: `no autonomy set and the repo caps it at ${cap}`,
    });
  }
  expect(decide({ a: null, cap: 4 })).toEqual({ merge: true });
  expect(effectiveA(null, null, 5, "me")).toBeNull();
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
  expect(planGate(5, 5, "github:issue#12")).toBe(true);
  expect(
    grantsFor({ a: 5, source: "alert", plan: null, unlock: [], network: [], defaults: [], unplanned: null })
      .open,
  ).toBe(false);
});

test("autonomy: spec gate", () => {
  // true = the owner merges the spec PR.
  expect(specGate(1, 5, false)).toBe(true);
  expect(specGate(2, 5, false)).toBe(true);
  expect(specGate(3, 5, false)).toBe(false);
  expect(specGate(5, 5, false)).toBe(false);
  expect(specGate(5, 5, true)).toBe(true);
  expect(specGate(5, 2, false)).toBe(true);
  expect(specGate(null, 2, false)).toBe(true);
  expect(specGate(null, 3, false)).toBe(false);
  expect(specGate(null, 5, true)).toBe(true);
});

test("autonomy: plan gate", () => {
  for (const a of [1, 2, 3, 4]) expect(planGate(a, 5, "me")).toBe(true);
  expect(planGate(null, 5, "me")).toBe(true);
  expect(planGate(5, 5, "me")).toBe(false);
  expect(planGate(5, 5, null)).toBe(false);
  expect(planGate(5, 4, "me")).toBe(true);
});

test("autonomy: a worker only lowers a", () => {
  expect(lowered(4, 2)).toBe(2);
  expect(lowered(4, 4)).toBeNull();
  expect(lowered(2, 3)).toBeNull();
  expect(lowered(4, null)).toBeNull();
  expect(lowered(4, 0)).toBeNull();
  expect(lowered(5, 6)).toBeNull();
  expect(lowered(5, 2.5)).toBeNull();
  // No `a`: at most 3.
  expect(lowered(null, 3)).toBe(3);
  expect(lowered(null, 1)).toBe(1);
  expect(lowered(null, 4)).toBeNull();
});

test("autonomy: access by level", () => {
  expect(accessPolicy(2)).toEqual({ network: "list", protectedPaths: "writable", request: "granted" });
  expect(accessPolicy(4)).toEqual({ network: "list", protectedPaths: "planned", request: "owner merges" });
  expect(accessPolicy(null)).toEqual(accessPolicy(4));
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
