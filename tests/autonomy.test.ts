// Autonomy (AUT-3, 4, 7, 8, 9, 11..15, 18, 19): effective `a`, the gates, lowering, access by level.

import { expect, test } from "vitest";
import {
  accessPolicy,
  effectiveA,
  type GateInput,
  gate,
  lowered,
  ownerOnly,
  ownerOnlyLine,
  planGate,
  riskWaits,
  shadowVerdict,
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
  expect(lowered(4, 0)).toBe(0);
  expect(lowered(0, 0)).toBeNull();
  expect(lowered(0, 3)).toBeNull();
  expect(lowered(4, -1)).toBeNull();
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
      tests: [],
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

test("autonomy: a0 waits at every gate", () => {
  // The spec and the plan go to the owner whatever the risk, even with nothing open.
  for (const risk of ["low", "medium", "high", null] as const) {
    expect(specGate(0, 0, risk)).toBe(true);
    expect(planGate(0, risk)).toBe(true);
  }
  // The merge goes to the owner with every check green, and says why.
  expect(decide({ a: 0 })).toEqual({
    merge: false,
    why: "This intent is only yours: you merge it yourself.",
  });
  // Test and network access are the owner's at every level (AUT-27), and a0 gets a1-a3's policy.
  expect(accessPolicy(0)).toEqual(accessPolicy(1));
  expect(accessPolicy(0).request).toBe("granted");
  expect(ownerOnly(0)).toBe(true);
  expect(ownerOnly(4)).toBe(false);
  expect(ownerOnly(null)).toBe(false);
  expect(ownerOnlyLine("261106-0500")).toBe("261106-0500 is only yours: use GitHub or the page");
});

test("autonomy: a0 is never raised", () => {
  // `a` at pick or now: either one at 0 keeps it at 0; removing `a` does not lift it.
  expect(effectiveA(0, 5, 5, "me")).toBe(0);
  expect(effectiveA(5, 0, 5, "me")).toBe(0);
  expect(effectiveA(0, null, 5, "me")).toBe(0);
  expect(effectiveA(null, 0, 5, null)).toBe(0);
  expect(ownerOnly(5, 0)).toBe(true);
  expect(ownerOnly(0, null)).toBe(true);
  // A worker can lower to a0 but never out of it.
  expect(lowered(3, 0)).toBe(0);
  expect(lowered(0, 5)).toBeNull();
  expect(lowered(0, 0)).toBeNull();
});

test("autonomy: a0 ignores risk and cap", () => {
  // A repo cap of 5 or 1 changes nothing; neither does a low risk.
  for (const cap of [1, 3, 5]) expect(effectiveA(0, 0, cap, "me")).toBe(0);
  expect(decide({ a: 0, risk: "low" }).merge).toBe(false);
  expect(decide({ a: 0, risk: "high" }).merge).toBe(false);
  // The checks still come first, with their own reasons.
  expect(decide({ a: 0, ciGreen: false })).toEqual({
    merge: false,
    why: "GitHub's automatic checks haven't passed.",
  });
});

const LINKS = { page: "http://127.0.0.1:7399/intent/261106-0500", pr: "https://github.com/o/r/pull/9" };

test("shadow: an a0 intent is refused", () => {
  for (const action of ["reply", "merge", "start", "boost", "drop", "resume"] as const) {
    const v = shadowVerdict({ aNow: 0 }, action, true, LINKS);
    expect(v.ok, action).toBe(false);
    expect(v.ok ? "" : v.reason).toContain("this intent is only yours");
  }
  // An intent that is not a0 is not guarded here.
  expect(shadowVerdict({ aNow: 4 }, "merge", false, LINKS)).toEqual({ ok: true });
  expect(shadowVerdict({ aNow: null }, "drop", false, LINKS)).toEqual({ ok: true });
  // `a` at pick counts too.
  expect(shadowVerdict({ aNow: 5, aAtPick: 0 }, "reply", true, LINKS).ok).toBe(false);
});

test("autonomy: telegram never answers an a0 intent", () => {
  // Telegram reaches Towercab through the shadow, so its replies are shadow actions: all refused,
  // whether or not the owner's message said yes or asked for it.
  for (const asked of [false, true]) {
    for (const action of ["reply", "merge", "drop", "start", "boost"] as const) {
      expect(shadowVerdict({ aNow: 0 }, action, asked, LINKS).ok, `${action} ${asked}`).toBe(false);
    }
  }
});

test("shadow: a yes does not unlock an a0 intent", () => {
  // `ownerAsked` is only about a pause: a yes to a held merge or drop changes nothing.
  expect(shadowVerdict({ aNow: 0 }, "merge", true, LINKS).ok).toBe(false);
  expect(shadowVerdict({ aNow: 0 }, "drop", true, LINKS).ok).toBe(false);
});

test("shadow: a refusal links the page and the PR", () => {
  const v = shadowVerdict({ aNow: 0 }, "reply", false, LINKS);
  expect(v).toEqual({
    ok: false,
    reason: `this intent is only yours: act on it at ${LINKS.page} or ${LINKS.pr}`,
  });
  const noPr = shadowVerdict({ aNow: 0 }, "reply", false, { page: LINKS.page });
  expect(noPr.ok ? "" : noPr.reason).toBe(`this intent is only yours: act on it at ${LINKS.page}`);
});

test("shadow: pause on an a0 intent needs the owner's request", () => {
  expect(shadowVerdict({ aNow: 0 }, "pause", true, LINKS)).toEqual({ ok: true });
  expect(shadowVerdict({ aNow: 0 }, "pause", false, LINKS).ok).toBe(false);
});

test("shadow: the shadow cannot resume an a0 intent", () => {
  expect(shadowVerdict({ aNow: 0 }, "resume", true, LINKS).ok).toBe(false);
  expect(shadowVerdict({ aNow: 0 }, "resume", false, LINKS).ok).toBe(false);
});
