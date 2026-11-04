// The GitHub form of reversing a refusal: the owner's plain `allow <path>` reply (PIP-141).

import { expect, test } from "vitest";
import { prEvents, reversalMarker, reversalRequested } from "../../src/github/events.ts";
import type { PrComment, PrState } from "../../src/github/prs.ts";
import { getMission, insertMission, patchData } from "../../src/mission.ts";
import { reverseRefusals } from "../../src/pipeline/access.ts";
import { testDb } from "../helpers/world.ts";
import { BOT } from "./fakes.ts";

const ME = "owner";
const A = "tests/a.test.ts";

const code = (comments: PrComment[]): PrState => ({
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
const said = (author: string, at: string, body: string, id: string): PrComment => ({ author, at, body, id });

function mission(data: Record<string, unknown>) {
  const db = testDb();
  const m0 = insertMission(db, { intent: "261001-0900", slug: "x", repo: "web", model: "opus", a: 5 }, 0);
  db.run(
    "UPDATE missions SET stage = 'build', step = '', pr = 7, feedback_seen = ? WHERE id = ?",
    "2026-11-04T10:00:00Z",
    m0.id,
  );
  patchData(db, getMission(db, m0.id)!, data, 0);
  return { db, m: getMission(db, m0.id)! };
}

test("pipeline: reversing on GitHub moves a refused test to allowed", () => {
  const { db, m } = mission({ refusedTests: [{ path: A, why: "w" }] });
  const c = code([said(ME, "2026-11-04T11:00:00Z", `allow ${A}`, "IC_1")]);
  // Not feedback for the worker: a reversal, answered once with a marker.
  expect(prEvents(m, { code: c }, ME, BOT)).toBeNull();
  const asks = reversalRequested(m, { code: c }, ME, BOT);
  expect(asks).toEqual([{ kind: "code", pr: 7, commentId: "IC_1", paths: [A], text: `allow ${A}` }]);
  const r = reverseRefusals(JSON.parse(m.data), asks[0]!.paths);
  const after = getMission(db, patchData(db, m, r.patch, 1).id)!;
  expect(JSON.parse(after.data).testAllowed).toEqual([{ path: A, why: "w" }]);
  expect(JSON.parse(after.data)).not.toHaveProperty("refusedTests");
  // Once the bot's reply with the marker is there, it is not done again.
  c.comments.push(
    said("towercab", "2026-11-04T11:01:00Z", `${reversalMarker("IC_1")}\nAllowed: \`${A}\``, "IC_2"),
  );
  expect(reversalRequested(after, { code: c }, ME, BOT)).toEqual([]);
});

test("pipeline: only the owner's allow, and not while a test question is open, reverses", () => {
  const c = code([
    said(ME, "2026-11-04T11:00:00Z", `allow ${A}`, "IC_1"),
    said("someone", "2026-11-04T11:00:00Z", `allow ${A}`, "IC_2"),
  ]);
  // Open question: the same words are its answer, so feedback, not a reversal.
  const open = mission({ testAsk: { path: A, why: "w", rest: [] } }).m;
  expect(reversalRequested(open, { code: c }, ME, BOT)).toEqual([]);
  expect(prEvents(open, { code: c }, ME, BOT)).toMatchObject({ event: "feedback", text: `allow ${A}` });
  // Otherwise only the owner's comment counts.
  const idle = mission({}).m;
  expect(reversalRequested(idle, { code: c }, ME, BOT).map((a) => a.commentId)).toEqual(["IC_1"]);
});
