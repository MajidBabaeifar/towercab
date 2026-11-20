// A comment under the owner's login that carries an agent's marker (PIP-185): ignored on an a0 intent,
// read as the owner's word elsewhere with the agent named; an unmarked one counts as before.

import { expect, test } from "vitest";
import { agentCommentNotes, recordAgentComment } from "../../src/commands.ts";
import { agentComments, prEvents } from "../../src/github/events.ts";
import { agentReplyBody } from "../../src/github/owner.ts";
import type { PrComment, PrState } from "../../src/github/prs.ts";
import { insertMission } from "../../src/mission.ts";
import { testDb } from "../helpers/world.ts";
import { BOT } from "./fakes.ts";

const ME = "owner";
const ID = "261001-0900";

const pr = (comments: PrComment[]): PrState => ({
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
const said = (body: string, id: string, at = "2026-11-06T10:00:00Z"): PrComment => ({
  author: ME,
  at,
  body,
  id,
});
const agent = (text: string, id: string, name = "claude-code") =>
  said(agentReplyBody(name, "Majid", text), id);

function blocked(a: number) {
  const db = testDb();
  const m = insertMission(db, { intent: ID, slug: "x", repo: "web", model: "opus", a }, 0);
  db.run("UPDATE missions SET stage = 'blocked', waiting = 'answer the question', pr = 7 WHERE id = ?", m.id);
  return { db, row: db.get<typeof m>("SELECT * FROM missions WHERE id = ?", m.id)! };
}

test("events: an agent-marked comment on an a0 intent is not an event", () => {
  const { row } = blocked(0);
  const code = pr([agent("Use the other table.", "c1"), agent("/retry", "c2")]);
  expect(prEvents(row, { code }, ME, BOT, undefined, true)).toBeNull();
  // The same comments, read on an intent that is not a0, are the owner's word.
  expect(prEvents(row, { code }, ME, BOT)?.event).toBe("answered");
});

test("events: an agent-marked comment on another intent still counts and names the agent", () => {
  const { row } = blocked(4);
  const code = pr([agent("Use the other table.", "c1")]);
  const o = prEvents(row, { code }, ME, BOT);
  expect(o?.event).toBe("answered");
  expect(o?.text).toContain("Use the other table.");
  expect(o?.data).toMatchObject({ answeredBy: "claude-code" });

  // A later answer of the owner's own clears the name (answeredBy is null, never left over).
  const mixed = prEvents(
    row,
    { code: pr([agent("a", "c1"), said("b", "c2", "2026-11-06T10:01:00Z")]) },
    ME,
    BOT,
  );
  expect(mixed?.data).toMatchObject({ answeredBy: null });
});

test("events: an unmarked comment under the owner's login still counts", () => {
  const { row } = blocked(0);
  // Quoting the marker on a later line is not a marker either.
  const code = pr([said("looks wrong, redo it", "c1"), said(`quote:\n<!-- towercab:agent:x -->`, "c2")]);
  const o = prEvents(row, { code }, ME, BOT, undefined, true);
  expect(o?.event).toBe("answered");
  expect(o?.data).not.toHaveProperty("answeredBy");
});

test("events: agent comments are listed once for the intent page", () => {
  const { db, row } = blocked(0);
  const code = pr([agent("Use the other table.", "c1"), said("mine", "c2")]);
  const found = agentComments(row, { code }, ME, BOT);
  expect(found.map((c) => [c.agent, c.pr, c.excerpt])).toEqual([
    ["claude-code", 7, "🤖 claude-code (for Majid) Use the other table."],
  ]);
  for (let pass = 0; pass < 3; pass++) {
    for (const c of found) {
      recordAgentComment(db, ID, c.key, {
        agent: c.agent,
        url: "https://github.com/me/web/pull/7",
        at: 100 + pass,
        excerpt: c.excerpt,
        actedOn: false,
      });
    }
  }
  expect(agentCommentNotes(db, ID)).toHaveLength(1);
  expect(agentCommentNotes(db, ID)[0]).toMatchObject({ agent: "claude-code", at: 100, actedOn: false });
});
