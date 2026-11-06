// SHD-9: the shadow merges a code PR only when nothing but the owner's approval holds it.

import { expect, test } from "vitest";
import type { IntentStore } from "../../src/intents/types.ts";
import { Executor } from "../../src/shadow/actions.ts";
import { pendingActions } from "../../src/shadow/store.ts";
import { Rig } from "./rig.ts";

const merge = { action: "merge", intent: "i-1", repo: "", title: "", text: "" };
const ready = {
  ci: { result: "green" },
  review: { approved: true, door: "two-way", redLines: false, summary: "", details: "", patchId: "p" },
};

function world(data: Record<string, unknown>, head = "abc", now = "abc") {
  const r = new Rig();
  r.mission("i-1", "approval:merge", "review and merge PR");
  r.db.run("UPDATE missions SET data = ?, head = ?", JSON.stringify(data), head);
  const exec = new Executor({
    db: r.db,
    clock: r.clock,
    config: r.config,
    store: r.store as unknown as IntentStore,
    ui: r.ui(),
    log: () => {},
    headOf: async () => now,
  });
  return { r, exec };
}

test("shadow: a merge waiting only on the owner asks for a yes", async () => {
  const { r, exec } = world(ready);
  expect(await exec.request(1, 0, merge)).toBe("Merge i-1? Reply yes or no.");
  expect(await exec.answer(true)).toBe("merge done");
  expect(r.calls).toEqual(["merge i-1"]);
});

const refused: [string, Record<string, unknown>, string, string][] = [
  ["red or pending checks", { ...ready, ci: { result: "pending" } }, "abc", "its checks aren't green yet"],
  ["no review", { ci: ready.ci }, "abc", "it hasn't been reviewed yet"],
  [
    "a review that did not approve",
    { ...ready, review: { ...ready.review, approved: false } },
    "abc",
    "the review didn't approve it",
  ],
  ["a head that moved after the review", ready, "def", "the PR changed after it was reviewed"],
  ["someone else's commits", { ...ready, foreignHead: true }, "abc", "someone else added commits to the PR"],
  [
    "tests never shown to fail",
    { ...ready, unproven: true },
    "abc",
    "its tests weren't shown to fail before the change",
  ],
];

for (const [name, data, now, why] of refused) {
  test(`shadow: a merge is refused for ${name}`, async () => {
    const { r, exec } = world(data, "abc", now);
    expect(await exec.request(1, 0, merge)).toBe(`I didn't merge i-1: ${why}.`);
    expect(pendingActions(r.db)).toEqual([]);
    expect(r.calls).toEqual([]);
  });
}

test("shadow: a yes does not merge a PR that changed while it waited", async () => {
  const { r, exec } = world(ready);
  await exec.request(1, 0, merge);
  const moved = new Executor({
    db: r.db,
    clock: r.clock,
    config: r.config,
    store: r.store as unknown as IntentStore,
    ui: r.ui(),
    log: () => {},
    headOf: async () => "zzz",
  });
  expect(await moved.answer(true)).toBe("I didn't merge i-1: the PR changed after it was reviewed.");
  expect(r.calls).toEqual([]);
});
