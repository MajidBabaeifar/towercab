// The code PR's conflict rounds when GitHub says CONFLICTING outside the merge step (PIP-134): in
// CI, and in the PR poll while a round is still running.

import { expect, test } from "vitest";
import { prEvents } from "../../src/github/events.ts";
import type { PrState } from "../../src/github/prs.ts";
import type { Stage } from "../../src/machine.ts";
import { getMission, insertMission } from "../../src/mission.ts";
import { happy, intent, intents, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";
import { testDb } from "../helpers/world.ts";

const conflicting: PrState = {
  state: "OPEN",
  mergedAt: null,
  mergeCommit: null,
  head: "h1",
  mergeable: "CONFLICTING",
  body: "",
  isDraft: false,
  reviews: [],
  comments: [],
};

function at(stage: Stage, rounds: number) {
  const db = testDb();
  const m0 = insertMission(db, { intent: "261001-0900", slug: "x", repo: "web", model: "opus", a: 5 }, 0);
  const data = JSON.stringify({ conflictRounds: { n: rounds, seen: null } });
  const waiting = stage === "blocked" ? "merge failed" : null;
  db.run(
    "UPDATE missions SET stage = ?, step = '', pr = 7, head = 'h1', waiting = ?, data = ? WHERE id = ?",
    stage,
    waiting,
    data,
    m0.id,
  );
  return getMission(db, m0.id)!;
}

test("pipeline: a conflict poll during the last round does not ask the owner", () => {
  // The second round has started (2 counted) but its merge is not pushed yet, so GitHub still says so.
  for (const stage of ["build", "verify", "proof", "publish"] as const)
    expect(prEvents(at(stage, 2), { code: conflicting }, "owner", "bot")).toBeNull();
  // Before the last round, and in the stages that take a conflict, the rules are PIP-134's.
  expect(prEvents(at("build", 1), { code: conflicting }, "owner", "bot")?.event).toBe("conflict");
  expect(prEvents(at("review", 2), { code: conflicting }, "owner", "bot")).toMatchObject({
    event: "wait",
    waiting: "merge failed",
  });
  // Once asked, the wait stands.
  expect(prEvents(at("blocked", 2), { code: conflicting }, "owner", "bot")).toBeNull();
});

/** The code PR reads CONFLICTING while `on()` holds. */
function conflictWhile(p: Pipe, on: () => boolean): void {
  const push = p.prs.push.bind(p.prs);
  p.prs.push = (...xs) => {
    for (const x of xs) {
      if (x.repo !== "owner/web" || x.head.endsWith("-spec")) continue;
      Object.defineProperty(x, "mergeable", {
        configurable: true,
        get: () => (on() ? "CONFLICTING" : "MERGEABLE"),
        set: () => {},
      });
    }
    return push(...xs);
  };
}

const conflicts = (p: Pipe) =>
  p.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM transitions WHERE event = 'conflict'")!.n;

test("pipeline: a code PR in conflict at CI is resolved without asking", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })), { keep: true });
  try {
    happy(p);
    conflictWhile(p, () => conflicts(p) < 1);
    await p.start();
    await p.until(() => p.mission()?.stage === "done", 90);
    expect(p.mission()!.stage, p.moves()).toBe("done");
    expect(conflicts(p)).toBe(1);
    expect(p.stages(p.mission()!.id)).not.toContain("blocked");
  } finally {
    p.cleanup();
  }
}, 120_000);

test("pipeline: a code PR that stays in conflict at CI asks the owner after two rounds", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })), { keep: true });
  try {
    happy(p);
    conflictWhile(p, () => true);
    await p.start();
    const blocked = await p.untilStage("blocked", 120);
    expect(blocked.waiting).toBe("merge failed");
    expect(conflicts(p)).toBe(2);
    expect(JSON.parse(blocked.data).conflictRounds.n).toBe(2);
  } finally {
    p.cleanup();
  }
}, 180_000);
