import { expect, test } from "vitest";
import { runAs } from "../src/actor.ts";
import { Db } from "../src/db.ts";
import { approveRequested, ignoredReplies, prEvents, voiceNotes } from "../src/github/events.ts";
import type { PrComment, PrReview, PrState } from "../src/github/prs.ts";
import { voicesFor } from "../src/github/voices.ts";
import type { GitHub } from "../src/handlers.ts";
import { insertMission } from "../src/mission.ts";
import { createActions } from "../src/ui/actions.ts";
import { addUser } from "../src/users-store.ts";
import { MemStore } from "../ui/fixture.ts";
import { BOT } from "./github/fakes.ts";
import { TestClock, testConfig, testDb } from "./helpers/world.ts";

const AUTH = { client_id: "id", client_secret_env: "X", public_url: "https://tc.example" };
const ana = { login: "ana", name: "Ana Diaz", role: "maintainer" as const, via: "page" as const };

function world(auth: boolean) {
  const db = Db.memory();
  const owner: string[][] = [];
  const app: string[][] = [];
  const ok = { code: 0, stdout: "", stderr: "", timedOut: false };
  const github: Pick<GitHub, "owner" | "gh"> = {
    owner: async (args) => {
      owner.push(args);
      return args[1] === "view" ? { ...ok, stdout: JSON.stringify({ state: "OPEN", mergedAt: null }) } : ok;
    },
    gh: async (_repo, args) => {
      app.push(args);
      return ok;
    },
  };
  const actions = createActions({
    db,
    store: new MemStore(),
    config: testConfig(auth ? { auth: AUTH } : {}),
    clock: new TestClock(),
    github,
  });
  db.run(
    `INSERT INTO missions (intent, repo, attempt, stage, waiting, model, session, checkout, branch, plan_pr, pr, created, updated)
     VALUES ('a-code', 'web', 1, 'approval:merge', 'review and merge PR', 'opus', 's', 'w', 'b', 31, 57, 0, 0)`,
  );
  return { db, actions, owner, app };
}

test("users: a pr comment names who approved", async () => {
  const w = world(true);
  await runAs(ana, () => w.actions.merge("a-code"));
  // Towercab comments as the App, with the person's name and the channel; the owner's login says nothing.
  expect(w.app).toEqual([
    ["pr", "comment", "57", "-R", "owner/web", "--body", "approved by Ana Diaz in Towercab (page)"],
  ]);
  expect(w.owner.some((a) => a[1] === "comment")).toBe(false);
  // Replying and dropping are named the same way.
  const r = world(true);
  await runAs(ana, () => r.actions.reply("a-code", "Please keep it small."));
  expect(r.owner).toContainEqual([
    "pr",
    "comment",
    "57",
    "-R",
    "owner/web",
    "--body",
    "answered by Ana Diaz in Towercab (page):\n\nPlease keep it small.",
  ]);
  const d = world(true);
  await runAs(ana, () => d.actions.drop("a-code", true));
  expect(d.owner).toContainEqual([
    "pr",
    "close",
    "57",
    "-R",
    "owner/web",
    "--comment",
    "dropped by Ana Diaz in Towercab (page)",
  ]);
});

test("users: the merge records who approved", async () => {
  const w = world(true);
  await runAs(ana, () => w.actions.merge("a-code"));
  const merge = w.owner.find((a) => a[1] === "merge")!;
  expect(merge).toEqual(["pr", "merge", "57", "--squash", "--body", "Approved-by: ana", "-R", "owner/web"]);
  // Without [auth] the merge and the comments are exactly what they were.
  const n = world(false);
  await runAs(ana, () => n.actions.merge("a-code"));
  expect(n.owner.find((a) => a[1] === "merge")).toEqual(["pr", "merge", "57", "--squash", "-R", "owner/web"]);
  expect(n.app).toEqual([]);
});

// USR-9: whose words on GitHub count, by role and repo.
const ID = "261001-0900";
const ME = "owner";
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
const said = (author: string, body: string, id = "c1"): PrComment => ({
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

function team(stage = "approval:merge", repo = "web") {
  const db = testDb();
  const add = (login: string, role: "viewer" | "contributor" | "maintainer" | "admin", repoRoles = {}) =>
    addUser(db, { login, name: login, role, repoRoles, by: "owner" }, 0);
  add("mia", "maintainer");
  add("max", "maintainer");
  add("vic", "viewer");
  add("con", "contributor");
  add("elsewhere", "viewer", { web: "viewer" });
  add("other", "viewer", { web: "viewer" });
  const m0 = insertMission(db, { intent: ID, slug: "x", repo, model: "opus", a: 3 }, 0);
  db.run(
    "UPDATE missions SET stage = ?, waiting = ?, pr = 7 WHERE id = ?",
    stage,
    "review and merge PR",
    m0.id,
  );
  db.run("INSERT INTO intent_people (intent, writer, at) VALUES (?, 'con', 0)", ID);
  const m = db.get<typeof m0>("SELECT * FROM missions WHERE id = ?", m0.id)!;
  return { db, m, voices: voicesFor(db, repo, ID) };
}

test("users: a maintainer's approval on github counts", () => {
  const t = team();
  const code = pr({ reviews: [review("mia", "APPROVED")] });
  expect(approveRequested(t.m, { code }, ME, false, t.voices)).toBe(7);
  // Without voices the owner's login still decides.
  expect(approveRequested(t.m, { code }, ME)).toBeNull();
  const feedback = pr({ comments: [said("MIA", "Please rename it.")] });
  expect(prEvents(t.m, { code: feedback }, ME, BOT, undefined, false, false, t.voices)).toMatchObject({
    event: "feedback",
    text: "Please rename it.",
  });
});

test("users: a contributor's comment answers a question they were asked", () => {
  const t = team("blocked");
  const code = pr({ comments: [said("con", "Use the monthly report.")] });
  expect(prEvents(t.m, { code }, ME, BOT, undefined, false, false, t.voices)).toMatchObject({
    event: "answered",
    text: "Use the monthly report.",
  });
});

test("users: a contributor's other comment is shown but moves nothing", () => {
  const t = team("approval:merge");
  const code = pr({ comments: [said("con", "Looks fine to me"), said("con", "/retry", "c2")] });
  expect(prEvents(t.m, { code }, ME, BOT, undefined, false, false, t.voices)).toBeNull();
  expect(voiceNotes(t.m, { code }, BOT, t.voices).map((n) => n.text)).toEqual([
    "con commented on the code PR: Looks fine to me",
    "con commented on the code PR: /retry",
  ]);
  // While no question is open, even the writer's answer is only a note.
  const asked = team("blocked");
  const reply = pr({ comments: [said("con", "/retry")] });
  expect(prEvents(asked.m, { code: reply }, ME, BOT, undefined, false, false, asked.voices)).toBeNull();
});

test("users: one maintainer's approval is enough", () => {
  const t = team();
  const code = pr({ reviews: [review("mia", "APPROVED")], comments: [said("max", "not yet")] });
  expect(approveRequested(t.m, { code }, ME, false, t.voices)).toBe(7);
});

test("users: a viewer's github comment is ignored", () => {
  const t = team();
  const code = pr({ comments: [said("vic", "ship it")], reviews: [review("vic", "APPROVED")] });
  expect(prEvents(t.m, { code }, ME, BOT, undefined, false, false, t.voices)).toBeNull();
  expect(approveRequested(t.m, { code }, ME, false, t.voices)).toBeNull();
  expect(ignoredReplies(t.m, { code }, ME, BOT, t.voices).map((r) => r.author)).toEqual(["vic", "vic"]);
});

test("users: an unknown account's github review is ignored", () => {
  const t = team();
  const code = pr({
    reviews: [review("stranger", "APPROVED"), review("stranger", "CHANGES_REQUESTED", "no")],
  });
  expect(approveRequested(t.m, { code }, ME, false, t.voices)).toBeNull();
  expect(prEvents(t.m, { code }, ME, BOT, undefined, false, false, t.voices)).toBeNull();
  // Not even the owner's login counts once people decide, unless they are one.
  expect(
    approveRequested(t.m, { code: pr({ reviews: [review(ME, "APPROVED")] }) }, ME, false, t.voices),
  ).toBeNull();
});

test("users: a maintainer on another repo is ignored", () => {
  const t = team();
  addUser(t.db, { login: "rae", role: "viewer", repoRoles: { api: "maintainer" }, by: "owner" }, 0);
  const code = pr({ reviews: [review("rae", "APPROVED")] });
  expect(approveRequested(t.m, { code }, ME, false, t.voices)).toBeNull();
  const api = voicesFor(t.db, "api", ID);
  expect(approveRequested(t.m, { code }, ME, false, api)).toBe(7);
});
