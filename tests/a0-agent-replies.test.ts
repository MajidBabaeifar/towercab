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
  const only = ownerOnly(null, row.a_at_pick);
  expect(only).toBe(true);
  const marked = code([reply(agentReplyBody("claude-code", "Majid", "Yes, merge it."), "c1")]);
  expect(prEvents(row, { code: marked }, ME, BOT, undefined, only)).toBeNull();
  // The owner's own comment still moves it.
  const both = code([...marked.comments, reply("redo the table", "c2")]);
  expect(prEvents(row, { code: both }, ME, BOT, undefined, only)?.event).toBe("feedback");
});
