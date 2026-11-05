// What a repo that needs a teammate's review adds to a PR read (PIP-142..145): who is heard, what is
// feedback, the owner's `/pass`, and the owner's Approve.

import { expect, test } from "vitest";
import { approveNotices, approveRequested, PASS, prEvents, type TeamReads } from "../../src/github/events.ts";
import type { PrComment, PrReview, PrState } from "../../src/github/prs.ts";
import type { Stage } from "../../src/machine.ts";
import { getMission, insertMission, type Mission } from "../../src/mission.ts";
import { testDb } from "../helpers/world.ts";
import { BOT } from "./fakes.ts";

const ME = "owner";

function world(stage: Stage, waiting: string, cols: Record<string, string | number | null> = {}): Mission {
  const db = testDb();
  const m0 = insertMission(db, { intent: "261001-0900", slug: "x", repo: "web", model: "opus", a: 3 }, 0);
  const all: Record<string, string | number | null> = {
    stage,
    step: "",
    waiting,
    pr: 7,
    spec_pr: 6,
    head: "h1",
    ...cols,
  };
  const keys = Object.keys(all);
  db.run(
    `UPDATE missions SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`,
    ...keys.map((k) => all[k]!),
    m0.id,
  );
  return getMission(db, m0.id)!;
}

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
const comment = (author: string, at: string, body: string, extra: Partial<PrComment> = {}): PrComment => ({
  author,
  at,
  body,
  id: `c${at}`,
  ...extra,
});
const review = (author: string, at: string, state: string, body = ""): PrReview => ({
  author,
  at,
  state,
  body,
  commit: "h1",
});

const team = (o: Partial<TeamReads> = {}): TeamReads => ({
  kind: "code",
  heard: new Set(["alice", "bob"]),
  approved: false,
  passable: false,
  approvedReviewIds: new Set(),
  ...o,
});

const waitingOnTeam = () => world("approval:merge", "teammate review");

test("events: a listed reviewer's request for changes is feedback", () => {
  const o = prEvents(
    waitingOnTeam(),
    { code: pr({ reviews: [review("Alice", "2026-11-05T10:00:00Z", "CHANGES_REQUESTED", "Rename it.")] }) },
    ME,
    BOT,
    team(),
  );
  expect(o?.event).toBe("feedback");
  expect(o?.text).toBe("Alice asked for changes: Rename it.");
  expect(o?.set?.feedback_seen).toBe("2026-11-05T10:00:00Z");
  // Without the body the request still says so.
  const bare = prEvents(
    waitingOnTeam(),
    { code: pr({ reviews: [review("bob", "2026-11-05T10:00:00Z", "CHANGES_REQUESTED")] }) },
    ME,
    BOT,
    team(),
  );
  expect(bare?.text).toBe("bob asked for changes: Changes requested.");
});

test("events: a listed reviewer's comment is feedback", () => {
  const prs = {
    code: pr({
      comments: [
        comment("alice", "2026-11-05T10:00:00Z", "Why not a map?"),
        comment("bob", "2026-11-05T10:01:00Z", "Typo", { path: "src/a.ts", line: 4, reviewId: "99" }),
      ],
    }),
  };
  const o = prEvents(waitingOnTeam(), prs, ME, BOT, team());
  expect(o?.event).toBe("feedback");
  expect(o?.text).toBe("alice: Why not a map?\n\nbob: src/a.ts:4: Typo");
  // A review that only comments is feedback as well.
  const c = prEvents(
    waitingOnTeam(),
    { code: pr({ reviews: [review("alice", "2026-11-05T10:00:00Z", "COMMENTED", "Looks odd")] }) },
    ME,
    BOT,
    team(),
  );
  expect(c?.text).toBe("alice: Looks odd");
});

test("events: a code owner's request for changes is feedback", () => {
  // A code owner is in `heard` like a listed login: the rules put them there (reviewersOf).
  const o = prEvents(
    waitingOnTeam(),
    {
      code: pr({ reviews: [review("carol", "2026-11-05T10:00:00Z", "CHANGES_REQUESTED", "Needs a test.")] }),
    },
    ME,
    BOT,
    team({ heard: new Set(["carol"]) }),
  );
  expect(o?.text).toBe("carol asked for changes: Needs a test.");
});

test("events: someone neither listed nor a code owner is ignored", () => {
  const prs = {
    code: pr({
      reviews: [review("mallory", "2026-11-05T10:00:00Z", "CHANGES_REQUESTED", "No.")],
      comments: [comment("mallory", "2026-11-05T10:01:00Z", "Nope")],
    }),
  };
  expect(prEvents(waitingOnTeam(), prs, ME, BOT, team())).toBeNull();
  // Without the setting nobody but the owner is heard (PIP-44).
  expect(
    prEvents(
      waitingOnTeam(),
      { code: pr({ comments: [comment("alice", "2026-11-05T10:01:00Z", "Hi")] }) },
      ME,
      BOT,
    ),
  ).toBeNull();
});

test("events: someone the host asked to review but who is not a code owner is ignored", () => {
  // The host's requests are not read at all: `heard` is the listed and the code owners only.
  const prs = {
    code: pr({ comments: [comment("requested-reviewer", "2026-11-05T10:01:00Z", "Please fix")] }),
  };
  expect(prEvents(waitingOnTeam(), prs, ME, BOT, team())).toBeNull();
});

test("events: a reviewer cannot send slash commands", () => {
  const prs = {
    code: pr({
      comments: [
        comment("alice", "2026-11-05T10:00:00Z", "/retry"),
        comment("alice", "2026-11-05T10:01:00Z", PASS),
        comment("bob", "2026-11-05T10:02:00Z", "allow tests/a.test.ts"),
      ],
    }),
  };
  expect(prEvents(waitingOnTeam(), prs, ME, BOT, team({ passable: true }))).toBeNull();
});

test("events: an approval with text is not feedback", () => {
  const prs = {
    code: pr({
      reviews: [review("alice", "2026-11-05T10:00:00Z", "APPROVED", "Looks good, maybe rename x later.")],
    }),
  };
  expect(prEvents(waitingOnTeam(), prs, ME, BOT, team())).toBeNull();
});

test("events: inline comments of an approval are not feedback", () => {
  const prs = {
    code: pr({
      reviews: [review("alice", "2026-11-05T10:00:00Z", "APPROVED")],
      comments: [
        comment("alice", "2026-11-05T10:00:00Z", "nit: spacing", {
          path: "src/a.ts",
          line: 1,
          reviewId: "42",
        }),
      ],
    }),
  };
  expect(prEvents(waitingOnTeam(), prs, ME, BOT, team({ approvedReviewIds: new Set(["42"]) }))).toBeNull();
  // The same comment in a review that is not an approval is feedback.
  expect(prEvents(waitingOnTeam(), prs, ME, BOT, team())?.event).toBe("feedback");
});

test("pipeline: reviewer feedback names who wrote it", () => {
  const o = prEvents(
    waitingOnTeam(),
    {
      code: pr({
        comments: [
          comment("owner", "2026-11-05T10:00:00Z", "Use a set."),
          comment("alice", "2026-11-05T10:01:00Z", "And a test."),
        ],
      }),
    },
    ME,
    BOT,
    team(),
  );
  // The owner's words stay as they were; a reviewer's name the reviewer.
  expect(o?.text).toBe("Use a set.\n\nalice: And a test.");
  expect(o?.data?.answer).toBe(o?.text);
});

test("pipeline: an approval's text is shown in the record", () => {
  const prs = {
    code: pr({
      reviews: [
        review("alice", "2026-11-05T10:00:00Z", "APPROVED", "Ship it."),
        review("bob", "2026-11-05T10:01:00Z", "APPROVED"),
      ],
    }),
  };
  const o = prEvents(waitingOnTeam(), prs, ME, BOT, team({ approved: true }));
  expect(o?.event).toBe("reviewed");
  expect(o?.data?.approvalNotes).toEqual(["alice approved: Ship it."]);
});

test("events: a teammate approval ends the wait", () => {
  const prs = { code: pr() };
  expect(prEvents(waitingOnTeam(), prs, ME, BOT, team({ approved: true }))?.event).toBe("reviewed");
  expect(prEvents(waitingOnTeam(), prs, ME, BOT, team())).toBeNull();
  // The spec PR's wait goes back to the design's gate.
  const spec = world("approval:spec", "teammate review of spec");
  const o = prEvents(spec, { spec: pr() }, ME, BOT, team({ kind: "spec", approved: true }));
  expect(o?.event).toBe("reviewed");
  expect(o?.data?.recheck).toBe(true);
  // Only a mission that waits for the teammates is moved by it.
  expect(
    prEvents(world("approval:merge", "review and merge PR"), prs, ME, BOT, team({ approved: true })),
  ).toBeNull();
});

test("events: pass comment passes it on", () => {
  const m = world("approval:merge", "review and merge PR");
  const prs = { code: pr({ comments: [comment("owner", "2026-11-05T10:00:00Z", PASS)] }) };
  const o = prEvents(m, prs, ME, BOT, team({ passable: true }));
  expect(o?.event).toBe("reviewed");
  expect(o?.data?.teammate).toEqual({ passedOn: "h1" });
  expect(o?.set?.feedback_seen).toBe("2026-11-05T10:00:00Z");
  // Not passable (nothing to pass on): the comment does nothing, and is not feedback.
  expect(prEvents(m, prs, ME, BOT, team())).toBeNull();
  // The words `/pass` mean nothing in a repo without the setting.
  expect(prEvents(m, prs, ME, BOT)?.event).toBe("feedback");
});

test("events: approve review does not pass it on", () => {
  const m = world("approval:merge", "review and merge PR");
  const prs = { code: pr({ reviews: [review("owner", "2026-11-05T10:00:00Z", "APPROVED")] }) };
  expect(prEvents(m, prs, ME, BOT, team({ passable: true }))).toBeNull();
});

test("pipeline: owner approve does not merge in a teammate review repo", () => {
  const m = world("approval:merge", "teammate review");
  const prs = { code: pr({ reviews: [review("owner", "2026-11-05T10:00:00Z", "APPROVED")] }) };
  expect(approveRequested(m, prs, ME)).toBe(7);
  expect(approveRequested(m, prs, ME, true)).toBeNull();
  // The plan PR is the owner's own: it still merges on their Approve.
  const plan = world("approval:plan", "approve plan", { plan_pr: 5 });
  expect(
    approveRequested(
      plan,
      { plan: pr({ reviews: [review("owner", "2026-11-05T10:00:00Z", "APPROVED")] }) },
      ME,
      true,
    ),
  ).toBe(5);
  // The owner is told once, by a reply carrying a marker.
  expect(approveNotices(m, prs, ME, BOT)).toEqual([
    { kind: "code", pr: 7, marker: "<!-- towercab:approve:2026-11-05T10:00:00Z -->" },
  ]);
  const answered = {
    code: pr({
      reviews: [review("owner", "2026-11-05T10:00:00Z", "APPROVED")],
      comments: [
        comment(BOT, "2026-11-05T10:01:00Z", "<!-- towercab:approve:2026-11-05T10:00:00Z -->\nsaid"),
      ],
    }),
  };
  expect(approveNotices(m, answered, ME, BOT)).toEqual([]);
});
