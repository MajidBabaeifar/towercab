// LOOP-78: the parts of a multi-repo mission: one cap, one ask, the slots of their repos, the way out.

import { expect, test } from "vitest";
import { apply } from "../src/machine.ts";
import { dataOf, getMission, insertMission, type Mission, update } from "../src/mission.ts";
import { applyPart, stopForCap } from "../src/partrun.ts";
import { capReached, partsOf, runBudget } from "../src/parts.ts";
import { workingIn } from "../src/slots.ts";
import { testDb } from "./helpers/world.ts";

const PLAN = {
  parts: ["infra", "web"],
  waitsOn: { infra: [], web: ["infra"] },
};

/** A mission that has just entered build from an approved plan, with its two parts. */
function building() {
  const db = testDb();
  const subject = (m: Mission) => ({ title: "Show a greeting", repo: m.repo, link: null });
  const cx = { db, now: 10, subject };
  let m = db.tx(() =>
    insertMission(db, { intent: "261026-1000", slug: "greet", repo: "web", model: "opus", a: 5 }, 1),
  );
  m = apply(cx, m, { event: "ok" });
  m = apply(cx, m, { event: "ok" });
  m = apply(cx, m, { event: "wait", waiting: "approve plan", data: { plan: PLAN } });
  expect(m.stage).toBe("approval:plan");
  m = apply(cx, m, { event: "plan_merged" });
  return { db, cx, m };
}

const toGate = (cx: ReturnType<typeof building>["cx"], m: Mission, repo: string): Mission => {
  for (let i = 0; i < 7; i++) m = applyPart(cx, getMission(cx.db, m.id)!, repo, { event: "ok" });
  return getMission(cx.db, m.id)!;
};

test("machine: the mission leaves the parts when all are at the gate", () => {
  const { cx, m } = building();
  expect(m.stage).toBe("build");
  expect(partsOf(m).map((p) => [p.repo, p.waitsOn])).toEqual([
    ["infra", []],
    ["web", ["infra"]],
  ]);
  // Each part moves on its own through the stages; the first one at the gate waits for the other.
  let cur = applyPart(cx, m, "infra", { event: "ok" });
  expect(partsOf(cur).map((p) => p.stage)).toEqual(["verify", "build"]);
  cur = toGate(cx, cur, "infra");
  expect(partsOf(cur).map((p) => p.atGate)).toEqual([true, false]);
  expect(cur.stage).toBe("build");
  cur = toGate(cx, cur, "web");
  expect(partsOf(cur).every((p) => p.atGate)).toBe(true);
  expect(cur.stage).toBe("merge");
});

test("loop: one part waiting does not stop the others", () => {
  const { db, cx, m } = building();
  const before = db.all("SELECT * FROM outbox").length;
  const waited = applyPart(cx, m, "infra", {
    event: "wait",
    waiting: "answer the question",
    why: "which one?",
  });
  expect(partsOf(waited).map((p) => p.waiting)).toEqual(["answer the question", null]);
  // The mission shows the wait, so the owner's answer reaches it; the other part goes on.
  expect(waited.stage).toBe("blocked");
  const next = applyPart(cx, waited, "web", { event: "ok" });
  expect(partsOf(next).map((p) => p.stage)).toEqual(["build", "verify"]);
  // The owner's answer lets the waiting part carry on from where it was.
  const answered = apply(cx, next, { event: "answered", text: "the first" });
  expect(answered.stage).toBe("build");
  expect(partsOf(answered).map((p) => p.waiting)).toEqual([null, null]);
  expect(partsOf(answered).map((p) => p.stage)).toEqual(["build", "verify"]);
  // The owner is asked about that part, once.
  expect(db.all("SELECT * FROM outbox")).toHaveLength(before + 1);
});

test("loop: the cap is one total for all parts", () => {
  const { db, cx, m } = building();
  // Runs of either part charge the one row of the mission.
  update(db, m.id, {}, 1);
  db.run("UPDATE missions SET cost_usd = 3 WHERE id = ?", m.id);
  const spent = getMission(db, m.id)!;
  expect(runBudget(10, 5, spent, true)).toBe(2);
  expect(runBudget(1, 5, spent, true)).toBe(1);
  expect(runBudget(null, 5, spent, true)).toBe(2);
  expect(capReached(5, spent)).toBe(false);
  expect(capReached(3, spent)).toBe(true);
  // One intent with one repo keeps the agent's own limit.
  expect(runBudget(10, 5, spent, false)).toBe(10);
  void cx;
});

test("loop: reaching the cap stops every part and asks once", () => {
  const { db, cx, m } = building();
  const before = db.all("SELECT * FROM outbox").length;
  const stopped = stopForCap(cx, m, "the intent's runs used up its budget");
  expect(partsOf(stopped).map((p) => p.waiting)).toEqual(["worker budget", "worker budget"]);
  // A second pass over the same mission asks nothing more.
  stopForCap(cx, stopped, "the intent's runs used up its budget");
  expect(db.all("SELECT * FROM outbox")).toHaveLength(before + 1);
});

test("loop: parts count in the workers of their repos", () => {
  const { db, m } = building();
  const all = [getMission(db, m.id)!];
  // The mission's lead is web, and its other part is in infra: it takes a slot in each.
  expect(workingIn(all, "web")).toHaveLength(1);
  expect(workingIn(all, "infra")).toHaveLength(1);
  expect(workingIn(all, "docs")).toHaveLength(0);
  expect(dataOf(all[0]!).parts).toHaveLength(2);
});

test("loop: a part at the gate that needs the owner's merge approval waits there for the others", () => {
  const { cx, m } = building();
  let cur = m;
  for (let i = 0; i < 6; i++) cur = applyPart(cx, cur, "infra", { event: "ok" });
  expect(partsOf(cur)[0]!.stage).toBe("gate");
  cur = applyPart(cx, cur, "infra", { event: "wait", waiting: "review and merge PR" });
  expect(partsOf(cur).map((p) => p.atGate)).toEqual([true, false]);
  expect(cur.stage).toBe("build");
});
