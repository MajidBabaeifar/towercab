// USR-8, USR-10: every action names who did it, on the record, in the timeline and on the PR.

import { expect, test } from "vitest";
import { Db } from "../src/db.ts";
import type { GitHub } from "../src/handlers.ts";
import { apply } from "../src/machine.ts";
import { insertMission } from "../src/mission.ts";
import type { Actor } from "../src/ui/actions.ts";
import { createActions } from "../src/ui/actions.ts";
import { intentPage } from "../src/ui/state.ts";
import { addUser, ensureFirstAdmin } from "../src/users/store.ts";
import { buildFixture, IDS, MemStore } from "../ui/fixture.ts";
import { TestClock, testConfig } from "./helpers/world.ts";

const ana: Actor = { login: "ana", name: "Ana B", via: "page", signed: true };

function world() {
  const db = Db.memory();
  const calls: string[][] = [];
  const owner: GitHub["owner"] = async (args) => {
    calls.push(args);
    const stdout = args[1] === "view" ? JSON.stringify({ state: "OPEN", mergedAt: null }) : "";
    return { code: 0, stdout, stderr: "", timedOut: false };
  };
  const comments: { n: number; text: string }[] = [];
  const app = {
    commentOnPr: async (_repo: string, n: number, text: string) => {
      comments.push({ n, text });
      return { ok: true, reason: "" };
    },
  };
  const actions = createActions({
    db,
    store: new MemStore(),
    config: testConfig(),
    clock: new TestClock(),
    github: { owner },
    app,
  });
  const mission = (intent: string, stage: string, pr: number | null, waiting: string | null) =>
    db.run(
      `INSERT INTO missions (intent, repo, attempt, stage, waiting, model, session, checkout, branch, pr, created, updated)
       VALUES (?, 'web', 1, ?, ?, 'opus', 's', 'w', 'b', ?, 0, 0)`,
      intent,
      stage,
      waiting,
      pr,
    );
  return { db, calls, comments, actions, mission };
}

test("users: an action records its actor and channel", async () => {
  const w = world();
  await w.actions.as!(ana).start("261026-0905-1");
  await w.actions.start("261026-0906-1");
  await w.actions.as!({ login: "bo", name: "bo", via: "telegram", signed: true }).pause();
  expect(w.db.all("SELECT name, actor, via, source FROM commands ORDER BY id")).toEqual([
    { name: "start", actor: "ana", via: "page", source: "ui" },
    // With nobody signed in the actor is the owner ([github].me of the test config).
    { name: "start", actor: expect.any(String), via: "page", source: "ui" },
    { name: "pause", actor: "bo", via: "telegram", source: "ui" },
  ]);
});

test("users: an action by towercab is recorded as towercab", () => {
  const db = Db.memory();
  const subject = () => ({ title: "Log in", repo: "web", link: null });
  let m = db.tx(() =>
    insertMission(db, { intent: "261026-1000", slug: "log-in", repo: "web", model: "opus", a: 3 }, 1),
  );
  const cx = { db, now: 10, subject };
  m = apply(cx, m, { event: "ok" });
  m = apply(cx, m, { event: "ok", actor: "ana", via: "github" });
  expect(db.all("SELECT event, actor, via FROM transitions ORDER BY id")).toEqual([
    { event: "ok", actor: "towercab", via: null },
    { event: "ok", actor: "ana", via: "github" },
  ]);
});

test("users: the timeline names who acted", async () => {
  const f = buildFixture({ now: 1_000_000 });
  try {
    ensureFirstAdmin(f.db, "owner", 1);
    addUser(
      f.db,
      { login: "owner", role: "admin", repos: {} },
      "ana",
      { name: "Ana B", role: "maintainer" },
      1,
    );
    const m = f.db.get<{ id: number }>("SELECT id FROM missions WHERE intent = ?", IDS.question)!;
    f.db.run(
      "INSERT INTO transitions (mission, at, from_stage, event, to_stage, why, actor, via) VALUES (?, 1000000, 'blocked', 'answered', 'build', NULL, 'ana', 'github')",
      m.id,
    );
    const page = await intentPage(f.sources, IDS.question);
    const entries = page!.timeline.filter((t) => t.actor);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.actor).toEqual({ login: "ana", name: "Ana B", via: "github" });
    // Towercab's own moves carry no person.
    expect(page!.timeline.some((t) => t.actor?.login === "towercab")).toBe(false);
  } finally {
    f.cleanup();
  }
});

test("users: a pr comment names who approved", async () => {
  const w = world();
  w.mission("a-code", "approval:merge", 57, "review and merge PR");
  await w.actions.as!(ana).merge("a-code");
  expect(w.comments).toEqual([{ n: 57, text: "Approved by Ana B in Towercab (page)." }]);
  // Dropping and retrying name the person too; a reply carries the name above the person's words.
  w.mission("a-drop", "approval:merge", 60, "review and merge PR");
  await w.actions.as!(ana).drop("a-drop");
  expect(
    w.calls.some((c) => c[1] === "close" && c.join(" ").includes("Dropped by Ana B in Towercab (page).")),
  ).toBe(true);
  w.mission("a-reply", "blocked", 61, "CI red");
  await w.actions.as!(ana).reply("a-reply", "use the blue one");
  const comment = w.calls.find((c) => c[1] === "comment" && c.join(" ").includes("blue"))!;
  expect(comment.join(" ")).toContain("Answered by Ana B in Towercab (page):");
  // Without sign-in the text is exactly what it was: no comment from Towercab, no name.
  const quiet = world();
  quiet.mission("a-code", "approval:merge", 57, "review and merge PR");
  await quiet.actions.merge("a-code");
  expect(quiet.comments).toEqual([]);
});

test("users: the merge records who approved", async () => {
  const w = world();
  w.mission("a-code", "approval:merge", 57, "review and merge PR");
  await w.actions.as!(ana).merge("a-code");
  const merge = w.calls.find((c) => c[1] === "merge")!;
  expect(merge).toContain("--body");
  expect(merge[merge.indexOf("--body") + 1]).toBe("Approved-by: ana");
  const quiet = world();
  quiet.mission("a-code", "approval:merge", 57, "review and merge PR");
  await quiet.actions.merge("a-code");
  expect(quiet.calls.find((c) => c[1] === "merge")).not.toContain("--body");
});
