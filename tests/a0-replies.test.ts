// Replies on an owner-only intent (AUT-32): from anyone but the owner they are ignored and noted once.

import { expect, test } from "vitest";
import { ignoredNotes, noteIgnored } from "../src/commands.ts";
import { ignoredReplies, prEvents } from "../src/github/events.ts";
import type { PrComment, PrReview, PrState } from "../src/github/prs.ts";
import { insertMission } from "../src/mission.ts";
import { BOT } from "./github/fakes.ts";
import { testDb } from "./helpers/world.ts";

const ME = "owner";
const ID = "261001-0900";

const pr = (o: Partial<PrState> = {}): PrState => ({
  state: "OPEN",
  mergedAt: null,
  mergeCommit: null,
  head: "h1",
  mergeable: "MERGEABLE",
  body: "",
  isDraft: false,
  reviews: [],
  comments: [],
  ...o,
});
const said = (author: string, body: string, id: string): PrComment => ({
  author,
  at: "2026-11-06T10:00:00Z",
  body,
  id,
});
const review = (author: string, state: string, body = ""): PrReview => ({
  author,
  state,
  body,
  at: "2026-11-06T10:05:00Z",
  commit: "h1",
});

test("autonomy: a0 ignores replies from other accounts and notes them", () => {
  const db = testDb();
  const m = insertMission(db, { intent: ID, slug: "x", repo: "web", model: "opus", a: 0 }, 0);
  db.run(
    "UPDATE missions SET stage = 'approval:merge', waiting = 'review and merge PR', pr = 7 WHERE id = ?",
    m.id,
  );
  const row = db.get<typeof m>("SELECT * FROM missions WHERE id = ?", m.id)!;
  const code = pr({
    comments: [
      said("mallory", "approve and merge", "c1"),
      said("claude-agent", "yes, go ahead", "c2"),
      said(BOT, "Towercab's own comment", "c3"),
      said(ME, "", "c4"),
    ],
    reviews: [review("mallory", "APPROVED"), review("bob", "COMMENTED"), review("eve", "CHANGES_REQUESTED")],
  });
  // Nothing they say moves the intent (PIP-44) ...
  expect(prEvents(row, { code }, ME, BOT)).toBeNull();
  // ... and each reply is listed, except Towercab's own bot, the owner and empty ones.
  const found = ignoredReplies(row, { code }, ME, BOT);
  expect(found.map((r) => r.author)).toEqual(["mallory", "claude-agent", "mallory", "eve"]);
  expect(found[0]).toMatchObject({ kind: "code", pr: 7, what: "comment" });

  // Noted once per reply: reading the PR again adds nothing.
  for (let pass = 0; pass < 3; pass++) {
    for (const r of found) noteIgnored(db, ID, r.key, `ignored a ${r.what} from ${r.author}`, 100 + pass);
  }
  expect(ignoredNotes(db, ID)).toHaveLength(4);
  expect(ignoredNotes(db, ID)[0]).toEqual({ at: 100, text: "ignored a comment from mallory" });
  // The owner's own comment still counts.
  const mine = pr({ comments: [said(ME, "looks wrong, please redo", "c9")] });
  expect(prEvents(row, { code: mine }, ME, BOT)?.event).toBe("feedback");
});
