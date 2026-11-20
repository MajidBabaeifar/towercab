// SHD-10, SHD-20: a yes answers the question it was meant for, once, even across a crash.

import { expect, test } from "vitest";
import { addOwnerTurn, nextTurn, pendingActions } from "../../src/shadow/store.ts";
import { Rig } from "./rig.ts";

const req = (action: string, intent: string) => ({ action, intent, repo: "", title: "", text: "" });

function two() {
  const r = new Rig();
  r.store.intents.set("i-2", { id: "i-2", title: "Second", source: "me", u: 3, i: 3 });
  r.mission("i-1", "approval:merge", "review and merge PR");
  return r;
}

test("shadow: a bare yes with two questions waiting answers neither", async () => {
  const r = two();
  const exec = r.exec();
  await exec.request(1, 0, req("merge", "i-1"));
  await exec.request(2, 0, req("drop", "i-2"));
  const line = await exec.answer(true);
  expect(line).toContain("More than one thing is waiting");
  expect(line).toContain("yes merge i-1");
  expect(r.calls).toEqual([]);
  expect(pendingActions(r.db)).toHaveLength(2);
  // A named yes answers that one only; the other still waits.
  expect(await exec.answer(true, { target: { action: "drop", intent: "i-2" } })).toContain("drop done");
  expect(r.calls).toEqual(["drop i-2"]);
  expect(pendingActions(r.db).map((p) => p.action)).toEqual(["merge"]);
  expect(await exec.answer(false, { target: { action: "merge", intent: "nope" } })).toContain(
    "Nothing is waiting",
  );
});

test("shadow: a named answer in the chat reaches the action it names", async () => {
  const r = two();
  const sh = r.shadow();
  r.say("merge i-1 and drop i-2");
  r.child({
    reply: "Asking.",
    actions: [req("merge", "i-1"), req("drop", "i-2")].map((a) => ({ ...a, repo: "", title: "", text: "" })),
  });
  await r.run(sh);
  r.say("yes");
  await r.run(sh);
  expect(r.calls).toEqual([]);
  r.say("yes drop i-2");
  await r.run(sh);
  expect(r.calls).toEqual(["drop i-2"]);
  expect(pendingActions(r.db).map((p) => p.intent)).toEqual(["i-1"]);
});

test("shadow: a yes interrupted by a crash is not answered again", async () => {
  const r = two();
  const exec = r.exec();
  await exec.request(1, 0, req("merge", "i-1"));
  const turn = r.db.run(
    "INSERT INTO shadow_turns (update_id, at, role, text, state) VALUES (9, ?, 'owner', 'yes', 'pending')",
    r.clock.now(),
  ).lastId;
  // The process dies after the yes took the merge off the list and ran it, before the turn was closed.
  await exec.answer(true, { turn });
  await exec.request(2, 0, req("drop", "i-2"));
  expect(nextTurn(r.db)?.id).toBe(turn);
  r.updates.push();
  await r.run(r.shadow());
  // The next held action was not approved by that old yes; the turn was closed with what happened.
  expect(r.calls).toEqual(["merge i-1"]);
  expect(pendingActions(r.db).map((p) => p.action)).toEqual(["drop"]);
  expect(r.outbox().at(-1)).toContain("merge done");
  expect(addOwnerTurn(r.db, 9, "yes", 1)).toBe(false);
});

test("shadow: a yes interrupted before the effect runs is reported, not run", async () => {
  const r = two();
  const exec = r.exec();
  await exec.request(1, 0, req("merge", "i-1"));
  const turn = r.db.run(
    "INSERT INTO shadow_turns (update_id, at, role, text, state) VALUES (9, ?, 'owner', 'yes', 'pending')",
    r.clock.now(),
  ).lastId;
  // Claimed (taken off the list, row `started`, turn linked), then the process died.
  r.db.run("UPDATE shadow_actions SET outcome = 'started', turn = ?, idx = 0", turn);
  r.db.delMeta("shadow.pending");
  await r.run(r.shadow());
  expect(r.calls).toEqual([]);
  expect(r.outbox().at(-1)).toContain("interrupted");
});
