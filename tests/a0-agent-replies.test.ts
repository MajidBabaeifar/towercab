// An a0 mission ignores an agent's reply written under the owner's login (PIP-185, AUT-32).

import { expect, test } from "vitest";
import { ownerOnly } from "../src/autonomy.ts";
import { prEvents } from "../src/github/events.ts";
import { agentReplyBody } from "../src/github/owner.ts";
import type { PrState } from "../src/github/prs.ts";
import { insertMission } from "../src/mission.ts";
import { BOT } from "./github/fakes.ts";
import { testDb } from "./helpers/world.ts";

const ME = "owner";

test("autonomy: an a0 mission ignores a marked agent reply", () => {
  const db = testDb();
  const m = insertMission(db, { intent: "261001-0900", slug: "x", repo: "web", model: "opus", a: 0 }, 0);
  db.run(
    "UPDATE missions SET stage = 'approval:merge', waiting = 'review and merge PR', pr = 7 WHERE id = ?",
    m.id,
  );
  const row = db.get<typeof m>("SELECT * FROM missions WHERE id = ?", m.id)!;
  const reply = (body: string, id: string) => ({ author: ME, at: "2026-11-06T10:00:00Z", body, id });
  const code = (comments: ReturnType<typeof reply>[]): PrState => ({
    state: "OPEN",
    mergedAt: null,
    mergeCommit: null,
    head: "h1",
    mergeable: "MERGEABLE",
    body: "",
    isDraft: false,
    reviews: [],
    comments,
  });
  const only = ownerOnly(0);
  expect(only).toBe(true);
  const marked = code([reply(agentReplyBody("claude-code", "Majid", "Yes, merge it."), "c1")]);
  expect(prEvents(row, { code: marked }, ME, BOT, undefined, only)).toBeNull();
  // The owner's own comment still moves it.
  const both = code([...marked.comments, reply("redo the table", "c2")]);
  expect(prEvents(row, { code: both }, ME, BOT, undefined, only)?.event).toBe("feedback");
});

test("autonomy: an a0 mission does not let a marked agent reply lift a refusal", async () => {
  const { reversalRequested } = await import("../src/github/events.ts");
  const db = testDb();
  const m = insertMission(db, { intent: "261001-0900", slug: "x", repo: "web", model: "opus", a: 0 }, 0);
  db.run("UPDATE missions SET stage = 'blocked', pr = 7 WHERE id = ?", m.id);
  const row = db.get<typeof m>("SELECT * FROM missions WHERE id = ?", m.id)!;
  const comment = (body: string, id: string) => ({ author: ME, at: "2026-11-06T10:00:00Z", body, id });
  const code: PrState = {
    state: "OPEN",
    mergedAt: null,
    mergeCommit: null,
    head: "h1",
    mergeable: "MERGEABLE",
    body: "",
    isDraft: false,
    reviews: [],
    comments: [
      comment(agentReplyBody("claude-code", "Majid", "allow tests/a.test.ts"), "c1"),
      comment("allow tests/b.test.ts", "c2"),
    ],
  };
  // At a0 only the owner's own `allow` counts; elsewhere both do.
  expect(reversalRequested(row, { code }, ME, BOT, true).map((a) => a.paths)).toEqual([["tests/b.test.ts"]]);
  expect(reversalRequested(row, { code }, ME, BOT).map((a) => a.paths)).toEqual([
    ["tests/a.test.ts"],
    ["tests/b.test.ts"],
  ]);
});
