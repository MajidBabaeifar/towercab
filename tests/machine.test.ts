import { describe, expect, test } from "vitest";
import {
  apply,
  continueTo,
  EVENTS,
  isWait,
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
        if (s === "done" || s === "stopped") expect(n.kind).toBe("ignore");
      }
    }
    // Spot checks against **Transitions**.
    const rows: [Stage, (typeof EVENTS)[number], string][] = [
      ["design", "ok", "→ plan"],
      ["verify", "red", "→ build"],
      ["proof", "red", "→ build"],
      ["ci", "red", "→ build"],
      ["review", "red", "unexpected"],
      ["approval:spec", "ok", "unexpected"],
      ["build", "timeout", "again"],
      ["approval:merge", "timeout", "ignore"],
      ["build", "limit", "cool"],
      ["blocked", "env_fail", "backoff"],
      ["ci", "crash", "recover"],
      ["blocked", "crash", "ignore"],
      ["approval:spec", "spec_merged", "→ plan"],
      ["approval:plan", "plan_merged", "→ build"],
      ["approval:merge", "code_merged", "→ done"],
      ["ci", "code_merged", "→ done"],
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
      "pick → design → plan → build → verify → proof → publish → ci → review → gate → merge → done",
    );
    for (let i = 0; i < ORDER.length - 1; i++) expect(show(next(ORDER[i]!, "ok"))).toBe(`→ ${ORDER[i + 1]}`);
    for (const w of Object.keys(WAITS)) expect(isWait(waitInfo(w).stage)).toBe(true);
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
