import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  apply,
  continueTo,
  EVENTS,
  isWait,
  isWorking,
  type Next,
  next,
  ORDER,
  phaseOf,
  STAGES,
  type Stage,
  WAITS,
  waitInfo,
} from "../src/machine.ts";
import { dataOf, getMission, insertMission, type Mission } from "../src/mission.ts";
import { testDb } from "./helpers/world.ts";

const show = (n: Next) => (n.kind === "go" ? `→ ${n.to}` : n.kind);

describe("machine", () => {
  test("machine: every stage and event pair is defined", () => {
    // Every pair answers, and finished stages ignore everything.
    for (const s of STAGES) {
      for (const e of EVENTS) {
        const n = next(s, e);
        expect(n.kind, `${s} × ${e}`).toBeTruthy();
        if (s === "done" || s === "stopped" || s === "unverified") expect(n.kind).toBe("ignore");
      }
    }
    // Spot checks against **Transitions**.
    const rows: [Stage, (typeof EVENTS)[number], string][] = [
      ["design", "ok", "→ plan"],
      ["verify", "red", "→ build"],
      ["proof", "red", "→ build"],
      ["ci", "red", "→ build"],
      ["review", "red", "→ build"],
      ["gate", "red", "unexpected"],
      ["approval:spec", "recheck", "→ design"],
      ["approval:plan", "recheck", "→ plan"],
      ["approval:merge", "recheck", "→ review"],
      ["blocked", "recheck", "ignore"],
      ["approval:spec", "ok", "unexpected"],
      ["build", "timeout", "again"],
      ["approval:merge", "timeout", "ignore"],
      ["build", "limit", "cool"],
      ["blocked", "env_fail", "backoff"],
      ["ci", "crash", "recover"],
      ["blocked", "crash", "ignore"],
      ["approval:spec", "spec_merged", "→ plan"],
      ["approval:plan", "plan_merged", "→ build"],
      ["approval:merge", "code_merged", "→ deploy"],
      ["ci", "code_merged", "→ deploy"],
      ["plan", "code_merged", "ignore"],
      ["approval:spec", "feedback", "→ design"],
      ["approval:plan", "feedback", "→ plan"],
      ["approval:merge", "feedback", "→ build"],
      ["blocked", "feedback", "continue"],
      ["review", "feedback", "→ build"],
      ["build", "feedback", "ignore"],
      ["blocked", "answered", "continue"],
      ["ci", "answered", "ignore"],
      ["gate", "conflict", "→ build"],
      ["verify", "conflict", "ignore"],
      ["review", "head_moved", "→ ci"],
      ["ci", "head_moved", "ignore"],
      ["approval:plan", "closed", "stop"],
      ["build", "intent_removed", "stop"],
      ["approval:merge", "retry_fresh", "fresh"],
      ["merge", "resume", "again"],
      ["gate", "resume", "ignore"],
    ];
    for (const [s, e, want] of rows) expect(show(next(s, e)), `${s} × ${e}`).toBe(want);
    expect(show(next("blocked", "spec_merged", "design"))).toBe("→ plan");
    expect(show(next("blocked", "spec_merged", "build"))).toBe("ignore");
    expect(show(next("blocked", "plan_merged", "plan"))).toBe("→ build");
  });

  test("machine: order", () => {
    expect(ORDER.join(" → ")).toBe(
      "pick → design → plan → build → verify → proof → publish → ci → review → gate → merge → steps → deploy → e2e → done",
    );
    for (let i = 0; i < ORDER.length - 1; i++) expect(show(next(ORDER[i]!, "ok"))).toBe(`→ ${ORDER[i + 1]}`);
    // `your steps` is the one wait that sits at a working stage (LOOP-74).
    for (const w of Object.keys(WAITS)) expect(isWait(waitInfo(w).stage), w).toBe(w !== "your steps");
    expect(phaseOf("design", null)).toBe("spec");
    expect(phaseOf("approval:plan", null)).toBe("plan");
    expect(phaseOf("ci", null)).toBe("code");
    expect(phaseOf("blocked", "plan")).toBe("plan");
    expect(phaseOf("stopped", null)).toBe("dropped");
  });

  test("machine: continue after an answer", () => {
    expect(continueTo("answer the question", "design")).toBe("design");
    expect(continueTo("answer the question", "verify")).toBe("build");
    expect(continueTo("crashed at ci", "ci")).toBe("ci");
    expect(continueTo("CI stuck", "ci")).toBe("ci");
    expect(continueTo("merge failed", "merge")).toBe("gate");
    expect(continueTo("add CLAUDE.md verifying block", "pick")).toBe("pick");

    const db = testDb();
    const subject = () => ({ title: "Log in", repo: "web", link: "https://example.com/pr/1" });
    let m: Mission = db.tx(() =>
      insertMission(db, { intent: "261026-1000", slug: "log-in", repo: "web", model: "opus", a: 3 }, 1),
    );
    const cx = { db, now: 10, subject };
    m = apply(cx, m, { event: "ok" });
    m = apply(cx, m, { event: "ok" });
    m = apply(cx, m, { event: "ok" });
    m = apply(cx, m, { event: "ok" });
    expect(m.stage).toBe("verify");
    m = apply(cx, m, { event: "wait", waiting: "checks red", why: "npm test failed" });
    expect([m.stage, m.waiting, m.from_stage]).toEqual(["blocked", "checks red", "verify"]);
    expect(db.all("SELECT key FROM outbox").length).toBe(1);
    m = apply(cx, m, { event: "answered", text: "the flaky test is known; skip it" });
    expect([m.stage, m.waiting, m.continued, m.repairs]).toEqual(["build", null, 1, 0]);
    expect(dataOf(m).answer).toBe("the flaky test is known; skip it");
    // A second wait sends a new message.
    m = apply(cx, m, { event: "ok" });
    m = apply(cx, m, { event: "wait", waiting: "checks red" });
    expect(db.all("SELECT key FROM outbox").length).toBe(2);
    // retry_fresh stops this attempt and starts the next at pick.
    const fresh = apply(cx, m, { event: "retry_fresh" });
    expect([fresh.stage, fresh.attempt, fresh.branch]).toEqual(["pick", 2, "towercab/261026-1000-log-in-2"]);
    expect(getMission(db, m.id)!.stage).toBe("stopped");
    // Three crashes in a row wait for the owner.
    let f = fresh;
    for (let i = 0; i < 3; i++) f = apply(cx, f, { event: "crash" });
    expect([f.stage, f.waiting]).toEqual(["blocked", "crashed at pick"]);
  });
});

test("machine: an answered question doesn't come back on a later wait", () => {
  const db = testDb();
  const subject = () => ({ title: "Log in", repo: "web", link: null });
  let m: Mission = db.tx(() =>
    insertMission(db, { intent: "261026-1000", slug: "log-in", repo: "web", model: "opus", a: 3 }, 1),
  );
  const cx = { db, now: 10, subject };
  for (let i = 0; i < 3; i++) m = apply(cx, m, { event: "ok" });
  expect(m.stage).toBe("build");
  const question = { context: "c", question: "Hello or bye?", options: [], recommendation: "hello" };
  m = apply(cx, m, {
    event: "wait",
    waiting: "answer the question",
    data: { question, brief: "Pick a word." },
  });
  expect(dataOf(m)).toMatchObject({ question, brief: "Pick a word." });
  m = apply(cx, m, { event: "answered", text: "hello" });
  // PIP-107: the next wait asks no question of its own, so the old one and its brief are gone.
  m = apply(cx, m, {
    event: "wait",
    waiting: "answer the question",
    why: "the worker tried something it may not",
  });
  expect(dataOf(m).question).toBeUndefined();
  expect(dataOf(m).brief).toBeUndefined();
});

test("machine: the page's done note ends with the wait", () => {
  const db = testDb();
  const subject = () => ({ title: "Log in", repo: "web", link: null });
  let m: Mission = db.tx(() =>
    insertMission(db, { intent: "261026-1000", slug: "log-in", repo: "web", model: "opus", a: 3 }, 1),
  );
  const cx = { db, now: 10, subject };
  for (let i = 0; i < 3; i++) m = apply(cx, m, { event: "ok" });
  m = apply(cx, m, { event: "wait", waiting: "checks red" });
  const note = { action: "retry", stage: "blocked", pr: 5, at: 10 };
  db.run(
    "UPDATE missions SET data = ? WHERE id = ?",
    JSON.stringify({ ...dataOf(m), doneByYou: note }),
    m.id,
  );
  m = getMission(db, m.id)!;
  // An event the wait ignores leaves the note; leaving the wait takes it.
  m = apply(cx, m, { event: "timeout" });
  expect(dataOf(m).doneByYou).toEqual(note);
  m = apply(cx, m, { event: "answered", text: "skip it" });
  expect(m.stage).not.toBe("blocked");
  expect(dataOf(m).doneByYou).toBeUndefined();
});

test("machine: plan merged while the slot is taken waits", () => {
  // The table still sends a merged plan to build; the loop holds the move while the repo builds
  // (LOOP-61), so the mission stays where it waits and no wait message is sent.
  expect(next("approval:plan", "plan_merged")).toEqual({ kind: "go", to: "build" });
  expect(next("plan", "plan_merged")).toEqual({ kind: "go", to: "build" });
  expect(next("blocked", "plan_merged", "plan")).toEqual({ kind: "go", to: "build" });
  expect(waitInfo("spec conflict").stage).toBe("blocked");
});

test("machine: ship transitions", () => {
  const rows: [Stage, (typeof EVENTS)[number], string][] = [
    ["merge", "code_merged", "→ deploy"],
    ["blocked", "code_merged", "→ deploy"],
    ["deploy", "ok", "→ e2e"],
    ["deploy", "red", "→ rollback"],
    ["deploy", "skip", "→ unverified"],
    ["e2e", "ok", "→ done"],
    ["e2e", "red", "→ rollback"],
    ["e2e", "skip", "unexpected"],
    ["rollback", "ok", "→ build"],
    ["rollback", "revert", "→ revert"],
    ["rollback", "red", "unexpected"],
    ["revert", "ok", "unexpected"],
    ["revert", "timeout", "again"],
    ["rollback", "crash", "recover"],
    ["e2e", "code_merged", "ignore"],
    ["deploy", "feedback", "ignore"],
    ["revert", "closed", "stop"],
  ];
  for (const [s, e, want] of rows) expect(show(next(s, e)), `${s} × ${e}`).toBe(want);
  // A wait after shipping keeps seeing its merged PR: that is no new merge.
  expect(show(next("blocked", "code_merged", "rollback"))).toBe("ignore");
  expect(show(next("blocked", "code_merged", "revert"))).toBe("ignore");
  expect(show(next("blocked", "code_merged", "e2e"))).toBe("ignore");
  expect(show(next("blocked", "code_merged", "verify"))).toBe("→ deploy");
  for (const s of ["steps", "deploy", "e2e", "rollback", "revert"] as Stage[]) {
    expect(isWorking(s), s).toBe(true);
    expect(phaseOf(s, null), s).toBe("code");
  }
  expect(waitInfo("rolled back, revise").stage).toBe("blocked");
  expect(waitInfo("rollback failed").ask).toBe(
    "Taking the broken change back out failed, so nothing more goes live in this repo until you fix it.",
  );
});

test("machine: every ask says what the owner decides, as the spec's table does", () => {
  // PIP-110: LOOP's table of asks is the code's, row for row; the keys stay as intent files store them.
  const table = readFileSync("specs/loop.md", "utf8").split("**Waits** (`waiting:`")[1]!;
  const rows = new Map<string, string>();
  for (const m of table.matchAll(/^\| `([^`]+)` \| [^|]+ \| (.+) \|$/gm)) {
    if (m[1] !== "waiting:") rows.set(m[1]!.replace(" <stage>", ""), m[2]!);
  }
  expect([...rows.keys()].sort()).toEqual(Object.keys(WAITS).sort());
  for (const [key, w] of Object.entries(WAITS)) {
    expect(rows.get(key), key).toBe(w.ask);
    // Plain words: no step names or Towercab's own vocabulary.
    expect(w.ask, key).not.toMatch(/\b(repair rounds?|worker|verify|proof|gate|approval)\b/);
  }
});

test("machine: steps and unverified transitions", () => {
  const none = { steps: false, nothingLive: false };
  // LOOP-73: a merge goes to `steps` only when an after-merge step is open, else straight to the deploy.
  expect(show(next("merge", "code_merged", null, { ...none, steps: true }))).toBe("→ steps");
  expect(show(next("approval:merge", "code_merged", null, { ...none, steps: true }))).toBe("→ steps");
  expect(show(next("blocked", "code_merged", "gate", { ...none, steps: true }))).toBe("→ steps");
  expect(show(next("merge", "code_merged", null, none))).toBe("→ deploy");
  // A wait that came out of a ship stage still ignores its merged PR; so does `steps` itself.
  expect(show(next("blocked", "code_merged", "steps", { ...none, steps: true }))).toBe("ignore");
  expect(show(next("steps", "code_merged", null, { ...none, steps: true }))).toBe("ignore");
  expect(show(next("steps", "ok"))).toBe("→ deploy");
  expect(show(next("steps", "feedback"))).toBe("ignore");
  expect(show(next("steps", "answered"))).toBe("ignore");
  expect(show(next("steps", "closed"))).toBe("stop");
  // SHIP-21: no live check ends unverified, unless the plan said there is nothing to check.
  expect(show(next("deploy", "skip", null, none))).toBe("→ unverified");
  expect(show(next("deploy", "skip", null, { ...none, nothingLive: true }))).toBe("→ done");
  expect(show(next("steps", "skip"))).toBe("unexpected");
  for (const e of EVENTS) expect(show(next("unverified", e)), `unverified × ${e}`).toBe("ignore");
  expect(phaseOf("unverified", null)).toBe("done");
  expect(phaseOf("steps", null)).toBe("code");
  expect(isWorking("steps")).toBe(true);
  expect(isWorking("unverified")).toBe(false);
  // The hold before the merge is a blocked wait from the gate, and continues at the gate.
  expect(waitInfo("your steps first").stage).toBe("blocked");
  expect(continueTo("your steps first", "gate")).toBe("gate");
  expect(waitInfo("your steps").stage).toBe("steps");

  // `apply` reads the facts from the mission's data: open steps send the merge to `steps`...
  const db = testDb();
  const cx = { db, now: 100, subject: (m: Mission) => ({ title: m.intent, repo: m.repo, link: null }) };
  const mk = (data: Record<string, unknown>) => {
    const m0 = insertMission(
      db,
      { intent: `i${db.all("SELECT 1 FROM missions").length}`, slug: "x", repo: "web", model: "m", a: 5 },
      1,
    );
    db.run(
      "UPDATE missions SET stage = 'merge', step = '', data = ? WHERE id = ?",
      JSON.stringify(data),
      m0.id,
    );
    return getMission(db, m0.id)!;
  };
  const step = { n: 1, when: "after", text: "add the secret", why: "the app needs it", done_at: null };
  expect(apply(cx, mk({ steps: [step] }), { event: "code_merged" }).stage).toBe("steps");
  // ...a ticked one, or a fix round, goes straight on...
  expect(
    apply(cx, mk({ steps: [{ ...step, done_at: "2026-11-04T10:00:00+01:00" }] }), { event: "code_merged" })
      .stage,
  ).toBe("deploy");
  expect(
    apply(cx, mk({ steps: [step], ship: { merges: [], fixes: 1 } }), { event: "code_merged" }).stage,
  ).toBe("deploy");
  // ...and a wait at `steps` keeps its text and the stage.
  const at = apply(cx, mk({ steps: [step] }), { event: "code_merged" });
  const waiting = apply(cx, at, { event: "wait", waiting: "your steps", why: "1. add the secret" });
  expect([waiting.stage, waiting.waiting, waiting.why]).toEqual(["steps", "your steps", "1. add the secret"]);
  expect(db.all("SELECT text FROM outbox WHERE mission = ?", waiting.id)).toHaveLength(1);
  // `skip` at deploy: unverified is final (finished is set), `done` when the plan claims nothing to check.
  const dep = (data: Record<string, unknown>) => {
    const m = mk(data);
    db.run("UPDATE missions SET stage = 'deploy' WHERE id = ?", m.id);
    return getMission(db, m.id)!;
  };
  const u = apply(cx, dep({}), { event: "skip" });
  expect([u.stage, u.finished]).toEqual(["unverified", 100]);
  expect(apply(cx, dep({ liveNoneWhy: "docs only" }), { event: "skip" }).stage).toBe("done");
  expect(apply(cx, u, { event: "closed" }).stage).toBe("unverified");
});
