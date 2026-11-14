// USR-9: a teammate's actions on GitHub count when their role allows it on that repo.

import { expect, test } from "vitest";
import { Db } from "../src/db.ts";
import { approvedBy, approveRequested, ignoredReplies, prEvents } from "../src/github/events.ts";
import type { PrComment, PrReview, PrState } from "../src/github/prs.ts";
import { getMission, insertMission, type Mission } from "../src/mission.ts";
import { type CheckInput, loginCheck } from "../src/users/check.ts";
import { People } from "../src/users/people.ts";
import { addUser, ensureFirstAdmin } from "../src/users/store.ts";
import type { User } from "../src/users.ts";
import { BOT } from "./github/fakes.ts";

const admin: User = { login: "owner", role: "admin", repos: {} };

function world(stage: Mission["stage"], cols: Record<string, string | number | null> = {}) {
  const db = Db.memory();
  ensureFirstAdmin(db, "owner", 1);
  const m0 = insertMission(db, { intent: "261001-0900", slug: "x", repo: "web", model: "opus", a: 3 }, 0);
  const all: Record<string, string | number | null> = { stage, step: "", ...cols };
  if (stage === "blocked" && !("waiting" in cols)) all.waiting = "CI red";
  if (stage === "approval:merge") all.waiting = "review and merge PR";
  if (stage === "approval:merge") all.pr = 5;
  const keys = Object.keys(all);
  db.run(
    `UPDATE missions SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`,
    ...keys.map((k) => all[k]!),
    m0.id,
  );
  const people = new People({ db, now: () => 100, inTeam: async () => false });
  return { db, m: getMission(db, m0.id)!, people };
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
const said = (author: string, at: string, body: string): PrComment => ({ author, at, body, id: `c${at}` });
const review = (author: string, at: string, state: string, body = ""): PrReview => ({
  author,
  at,
  state,
  body,
  commit: "h1",
});

const input = (o: Partial<CheckInput> = {}): CheckInput => ({
  me: "owner",
  repos: ["web"],
  writer: null,
  asking: false,
  ...o,
});
const authorsOf = (p: PrState) => [...p.comments.map((c) => c.author), ...p.reviews.map((r) => r.author)];

test("users: a maintainer's approval on github counts", async () => {
  const w = world("approval:merge");
  addUser(w.db, admin, "max", { role: "maintainer" }, 1);
  const code = pr({ reviews: [review("Max", "2026-10-15T10:00:00Z", "APPROVED")] });
  const check = await loginCheck(w.people, input(), authorsOf(code));
  expect(approveRequested(w.m, { code }, check)).toBe(5);
  expect(approvedBy(w.m, { code }, check)).toBe("max");
  // The same review under the single-owner rule does not count (PIP-44).
  expect(approveRequested(w.m, { code }, "owner")).toBeNull();
});

test("users: one maintainer's approval is enough", async () => {
  const w = world("approval:merge");
  addUser(w.db, admin, "max", { role: "maintainer" }, 1);
  addUser(w.db, admin, "mia", { role: "maintainer" }, 1);
  // Mia asked for changes on someone else's account earlier; Max's approval alone moves it.
  const code = pr({
    reviews: [
      review("mia", "2026-10-15T09:00:00Z", "COMMENTED", ""),
      review("max", "2026-10-15T10:00:00Z", "APPROVED"),
    ],
  });
  const check = await loginCheck(w.people, input(), authorsOf(code));
  expect(approveRequested(w.m, { code }, check)).toBe(5);
});

test("users: a viewer's github comment is ignored", async () => {
  const w = world("blocked");
  addUser(w.db, admin, "vi", { role: "viewer" }, 1);
  const code = pr({
    comments: [
      said("vi", "2026-10-15T10:00:00Z", "please use blue"),
      said("vi", "2026-10-15T10:01:00Z", "/retry"),
    ],
  });
  const check = await loginCheck(w.people, input(), authorsOf(code));
  expect(prEvents(w.m, { code }, check, BOT)).toBeNull();
  // Not a contributor either: nothing is noted on the timeline.
  expect(check.contributor("vi")).toBe(false);
});

test("users: an unknown account's github review is ignored", async () => {
  const w = world("approval:merge");
  const code = pr({ reviews: [review("stranger", "2026-10-15T10:00:00Z", "APPROVED")] });
  const check = await loginCheck(w.people, input(), authorsOf(code));
  expect(approveRequested(w.m, { code }, check)).toBeNull();
  expect(prEvents(w.m, { code }, check, BOT)).toBeNull();
  addUser(w.db, admin, "off", { role: "maintainer" }, 1);
  w.db.run("UPDATE users SET disabled_at = 2 WHERE login = 'off'");
  const gone = pr({ reviews: [review("off", "2026-10-15T10:00:00Z", "APPROVED")] });
  expect(
    approveRequested(w.m, { code: gone }, await loginCheck(w.people, input(), authorsOf(gone))),
  ).toBeNull();
});

test("users: a maintainer on another repo is ignored", async () => {
  const w = world("approval:merge");
  // Maintainer on api, viewer on web: the intent is in web.
  addUser(w.db, admin, "ann", { role: "viewer", repos: { api: "maintainer" } }, 1);
  const code = pr({ reviews: [review("ann", "2026-10-15T10:00:00Z", "APPROVED")] });
  const check = await loginCheck(w.people, input({ repos: ["web"] }), authorsOf(code));
  expect(approveRequested(w.m, { code }, check)).toBeNull();
  const onApi = await loginCheck(w.people, input({ repos: ["api"] }), authorsOf(code));
  expect(approveRequested(w.m, { code }, onApi)).toBe(5);
  // An intent that changes both repos needs the role on both.
  const both = await loginCheck(w.people, input({ repos: ["api", "web"] }), authorsOf(code));
  expect(approveRequested(w.m, { code }, both)).toBeNull();
});

test("users: a contributor's comment answers a question they were asked", async () => {
  const w = world("blocked");
  addUser(w.db, admin, "cy", { role: "contributor" }, 1);
  const code = pr({ comments: [said("cy", "2026-10-15T10:00:00Z", "Use the customer's currency.")] });
  const asked = await loginCheck(w.people, input({ writer: "cy", asking: true }), authorsOf(code));
  const o = prEvents(w.m, { code }, asked, BOT);
  expect(o).toMatchObject({
    event: "answered",
    text: "Use the customer's currency.",
    actor: "cy",
    via: "github",
  });
  // Not their intent, or nothing is asked: the same words move nothing.
  const other = await loginCheck(w.people, input({ writer: "someone", asking: true }), authorsOf(code));
  expect(prEvents(w.m, { code }, other, BOT)).toBeNull();
  const idle = await loginCheck(w.people, input({ writer: "cy", asking: false }), authorsOf(code));
  expect(prEvents(w.m, { code }, idle, BOT)).toBeNull();
  // `/retry` is a command: a contributor never starts a fresh attempt.
  const retry = pr({ comments: [said("cy", "2026-10-15T10:00:00Z", "/retry")] });
  expect(prEvents(w.m, { code: retry }, asked, BOT)).toBeNull();
});

test("users: a contributor's other comment is shown but moves nothing", async () => {
  const w = world("approval:merge");
  addUser(w.db, admin, "cy", { role: "contributor" }, 1);
  const code = pr({ comments: [said("cy", "2026-10-15T10:00:00Z", "looks fine to me")] });
  const check = await loginCheck(w.people, input({ writer: "cy" }), authorsOf(code));
  expect(prEvents(w.m, { code }, check, BOT)).toBeNull();
  // The loop notes it once on the intent: it lists the reply and says the author is a contributor.
  const listed = ignoredReplies(w.m, { code }, check, BOT);
  expect(listed.map((r) => r.author)).toEqual(["cy"]);
  expect(check.contributor("cy")).toBe(true);
  expect(w.db.all("SELECT 1 FROM transitions")).toEqual([]);
});
