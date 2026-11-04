import { describe, expect, test } from "vitest";
import { type ApplyCtx, apply, type Outcome, ok, WAITS, wait } from "../src/machine.ts";
import { getMission, insertMission, type Mission } from "../src/mission.ts";
import { type OutboxRow, sendDue, waitObsolete } from "../src/outbox.ts";
import { testDb } from "./helpers/world.ts";

function world() {
  const db = testDb();
  const cx: ApplyCtx = {
    db,
    now: 100,
    subject: () => ({ title: "Ship it", repo: "web", link: "https://github.com/me/web/pull/7" }),
  };
  const m = insertMission(db, { intent: "261001-0900", slug: "x", repo: "web", model: "opus", a: 3 }, 0);
  const sent: string[] = [];
  const sender = {
    async send(text: string) {
      sent.push(text);
    },
  };
  const rows = () => db.all<OutboxRow>("SELECT * FROM outbox ORDER BY created, rowid");
  let mission: Mission = m;
  const move = (o: Outcome) => {
    mission = apply(cx, mission, o);
    return mission;
  };
  const at = (stage: Mission["stage"]) => {
    db.run("UPDATE missions SET stage = ?, step = '' WHERE id = ?", stage, mission.id);
    mission = getMission(db, mission.id)!;
  };
  return {
    db,
    cx,
    sent,
    sender,
    rows,
    move,
    at,
    get m() {
      return mission;
    },
  };
}

describe("outbox", () => {
  test("outbox: only actionable messages", async () => {
    const w = world();
    // Work moving on, limits, merges and done: no message.
    w.move(ok());
    w.move({ event: "limit", limit: { model: "opus", until: 500, backoffs: 0, text: "429" } });
    w.at("ci");
    w.move({ event: "code_merged", set: { merge_sha: "m1" } });
    expect(w.m.stage).toBe("deploy");
    // SHIP-21: no live check ends as merged, not verified live, without a message.
    w.move({ event: "skip" });
    expect(w.m.stage).toBe("unverified");
    expect(w.rows()).toEqual([]);

    // The owner closing the PR: no message.
    const c = world();
    c.at("approval:merge");
    c.move({ event: "closed" });
    expect(c.rows()).toEqual([]);

    // A wait on the owner: one message, sent once.
    const s = world();
    s.at("design");
    s.move(wait("approve spec"));
    expect(s.rows()).toHaveLength(1);
    expect(await sendDue(s.db, s.sender, 100)).toEqual({ sent: 1, dropped: 0, failed: null });
    expect(await sendDue(s.db, s.sender, 200)).toEqual({ sent: 0, dropped: 0, failed: null });
    expect(s.sent).toEqual([
      "Decide if this is the right change to build: merge the spec PR to go ahead, or comment what to change.\nShip it (web)\nhttps://github.com/me/web/pull/7",
    ]);
    // The same wait again after feedback is a new message.
    s.move({ event: "feedback", text: "split it" });
    s.at("design");
    s.move(wait("approve spec"));
    expect(s.rows().map((r) => r.key)).toEqual([`${s.m.id}:approve spec:0`, `${s.m.id}:approve spec:1`]);
    expect((await sendDue(s.db, s.sender, 300)).sent).toBe(1);
  });

  test("outbox: every wait has a text", async () => {
    for (const key of Object.keys(WAITS)) {
      const waiting =
        key === "crashed at" ? "crashed at build" : key === "bad after:" ? "bad after: 261001-0800" : key;
      const w = world();
      w.at("build");
      w.move(wait(waiting, "test_x failed\n  at line 3"));
      expect(w.m.waiting, key).toBe(waiting);
      const [row] = w.rows();
      expect(row, key).toBeDefined();
      expect(row!.text.split("\n"), key).toEqual([
        WAITS[key]!.ask,
        "Ship it (web)",
        "test_x failed at line 3",
        "https://github.com/me/web/pull/7",
      ]);
      expect(waitObsolete(w.db)(row!), key).toBe(false);
      expect((await sendDue(w.db, w.sender, 100)).sent, key).toBe(1);
    }
  });

  test("outbox: an obsolete message is dropped", async () => {
    const w = world();
    w.at("design");
    w.move(wait("approve spec"));
    // A message of another kind (no mission) never is.
    w.db.run(
      "INSERT INTO outbox (key, mission, text, created) VALUES ('fault:github:1', NULL, 'GitHub down', 101)",
    );
    // The owner merged before it went out: the wait is over, so it is dropped, not sent.
    w.move({ event: "spec_merged" });
    expect(w.m.stage).toBe("plan");
    expect(await sendDue(w.db, w.sender, 120)).toEqual({ sent: 1, dropped: 1, failed: null });
    expect(w.sent).toEqual(["GitHub down"]);
    expect(w.rows().map((r) => r.sent_at)).toEqual([0, 120]);

    // Left and entered again: the old message is stale, the new one goes.
    const r = world();
    r.at("approval:merge");
    r.db.run("UPDATE missions SET waiting = 'review and merge PR' WHERE id = ?", r.m.id);
    r.db.run(
      "INSERT INTO outbox (key, mission, text, created) VALUES (?, ?, 'old', 90)",
      `${r.m.id}:review and merge PR:0`,
      r.m.id,
    );
    r.move({ event: "head_moved" });
    r.at("gate");
    r.move(wait("review and merge PR"));
    expect(await sendDue(r.db, r.sender, 130)).toEqual({ sent: 1, dropped: 1, failed: null });
    expect(r.sent[0]).toMatch(/^Decide if this change can go live: merge the PR/);
    // Another wait now, or a finished or missing mission: obsolete.
    const stale = (key: string, mission: number): OutboxRow => ({
      key,
      mission,
      text: "",
      created: 0,
      sent_at: null,
      tries: 0,
      next_try: 0,
    });
    const isObsolete = waitObsolete(r.db);
    expect(isObsolete(stale(`${r.m.id}:review and merge PR:1`, r.m.id))).toBe(false);
    expect(isObsolete(stale(`${r.m.id}:CI red:1`, r.m.id))).toBe(true);
    expect(isObsolete(stale("999:CI red:0", 999))).toBe(true);
    r.move({ event: "code_merged" });
    expect(isObsolete(stale(`${r.m.id}:review and merge PR:1`, r.m.id))).toBe(true);
  });
});
