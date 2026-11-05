// LOOP-77: the same wait again with nothing new is stuck, and offers only the other exits.

import { expect, test } from "vitest";
import { applyCommand, insertCommand } from "../src/commands.ts";
import { Db } from "../src/db.ts";
import type { Intent, IntentStore } from "../src/intents/types.ts";
import { apply, exitsOf, wait } from "../src/machine.ts";
import { dataOf, insertMission, unfinishedFor } from "../src/mission.ts";
import { renderStatus } from "../src/status.ts";
import { exitsWorld } from "./helpers/exits.ts";

/** The worker finishes with no changes; the owner's reply (if any) sends it back to build. */
function again(w: ReturnType<typeof exitsWorld>, reply?: string) {
  w.move({ event: "answered", ...(reply ? { text: reply } : {}) });
  return w.move(wait("no changes", "nothing changed"));
}

test("machine: the same wait again with nothing new is stuck", () => {
  const w = exitsWorld();
  w.set({ stage: "build", head: "abc" });
  w.move(wait("no changes", "nothing changed"));
  expect(dataOf(w.m).stuck).toBeUndefined();
  // Back at the same wait: same wait, same head, no new answer.
  expect(dataOf(again(w)).stuck).toBe(true);
  expect(exitsOf("no changes", true).map((e) => e.do)).toEqual(["done", "steps", "retry", "drop"]);
  // The message and the status offer only the exits that change something.
  const msg = w.db.all<{ text: string }>("SELECT text FROM outbox ORDER BY created, rowid").at(-1)!.text;
  expect(msg.split("\n")[1]).toMatch(/^Stuck: this came back with nothing new\. You can: Nothing to build/);
  expect(msg.split("\n")[1]).not.toMatch(/Reply/);
});

test("machine: something new clears stuck", () => {
  const w = exitsWorld();
  w.set({ stage: "build", head: "abc" });
  w.move(wait("no changes"));
  expect(dataOf(again(w)).stuck).toBe(true);
  // An answer from the owner is new.
  expect(dataOf(again(w, "try the other file")).stuck).toBeUndefined();
  // So is another head.
  expect(dataOf(again(w)).stuck).toBe(true);
  w.move({ event: "answered" });
  w.set({ head: "def" });
  expect(dataOf(w.move(wait("no changes"))).stuck).toBeUndefined();
});

test("outbox: a stuck wait offers only the other exits", () => {
  const w = exitsWorld();
  w.set({ stage: "build", head: "abc" });
  w.move(wait("worker timeout"));
  expect(w.move({ event: "answered" }).stage).toBe("build");
  const m = w.move(wait("worker timeout"));
  expect(dataOf(m).stuck).toBe(true);
  const msg = w.db.all<{ text: string }>("SELECT text FROM outbox ORDER BY created, rowid").at(-1)!.text;
  expect(msg).toContain("You can: Start over, Drop.");
  // Status shows the same.
  const out = renderStatus({
    db: w.db,
    listing: null,
    listingError: null,
    running: 1,
    version: "1",
    now: 100,
    problems: [],
    next: "next: nothing",
    prLink: () => null,
    queued: new Set(),
  });
  expect(out).toContain("stuck: this came back with nothing new");
  expect(out).toContain("you can: Start over, Drop");
  expect(out).not.toContain("you can: Reply");
});

test("cli: answer on a stuck mission is refused", async () => {
  const db = Db.memory();
  const ID = "261026-1000";
  const now = 1_793_000_000;
  const store = {
    get: async () => ({ id: ID, stage: null, waiting: "no changes" }) as Intent,
    update: async () => ({}) as Intent,
  } as unknown as IntentStore;
  const applyCtx = { db, now, subject: () => ({ title: "t", repo: "web", link: null }) };
  const m = db.tx(() => insertMission(db, { intent: ID, slug: "t", repo: "web", model: "opus", a: 3 }, now));
  db.run("UPDATE missions SET stage = 'build' WHERE id = ?", m.id);
  const w = apply(applyCtx, unfinishedFor(db, ID)!, wait("no changes"));
  const stuck = apply(applyCtx, apply(applyCtx, w, { event: "answered" }), wait("no changes"));
  expect(dataOf(stuck).stuck).toBe(true);
  const row = {
    id: insertCommand(db, { name: "answer", arg: ID, text: "please try", source: "cli" }, now),
    name: "answer" as const,
    arg: ID,
    text: "please try",
    source: "cli",
    created: now,
    applied_at: null,
    result: null,
  };
  const r = await applyCommand({ db, store, applyCtx, now: new Date(now * 1000) }, row);
  expect(r).toBe(
    `answer: ${ID} is stuck at no changes: a reply would land here again; use steps, done, retry or drop`,
  );
  expect(unfinishedFor(db, ID)?.stage).toBe("blocked");
});
