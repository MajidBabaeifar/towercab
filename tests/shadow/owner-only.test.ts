// SHD-21, SHD-22: the shadow stays out of an a0 intent; only a pause the owner asked for is allowed.

import { expect, test } from "vitest";
import { pendingActions } from "../../src/shadow/store.ts";
import { Rig } from "./rig.ts";

const line = "i-0 is only yours: use GitHub or the page";
const req = (action: string, extra: Record<string, string> = {}) => ({
  action,
  intent: "i-0",
  repo: "",
  title: "",
  text: "",
  ...extra,
});

function world(free: string[] = []) {
  const r = new Rig({ free });
  (r.store.intents as Map<string, unknown>).set("i-0", {
    id: "i-0",
    title: "Only mine",
    source: "shadow",
    u: 3,
    i: 3,
    a: 0,
  });
  r.mission("i-0", "approval:merge", "review and merge PR");
  return r;
}
const outcomes = (r: Rig) =>
  r.db.all<{ action: string; outcome: string }>("SELECT action, outcome FROM shadow_actions ORDER BY id");

for (const action of ["reply", "start", "confirm", "merge", "boost", "drop"]) {
  test(`shadow: an a0 intent refuses ${action}, even when it is free`, async () => {
    const r = world(["merge", "boost", "drop"]);
    const said = await r.exec().request(1, 0, req(action, { text: "ok" }));
    expect(said).toBe(`I didn't ${action} i-0: ${line}.`);
    expect(r.calls).toEqual([]);
    expect(r.store.updated).toEqual([]);
    expect(pendingActions(r.db)).toEqual([]);
    expect(outcomes(r)).toEqual([{ action, outcome: "refused" }]);
  });
}

test("shadow: a yes does not unlock an a0 intent", async () => {
  const r = world();
  // The intent was an ordinary one when asked, then became a0 before the yes.
  (r.store.intents.get("i-0") as unknown as { a: number | null }).a = 3;
  const exec = r.exec();
  expect(await exec.request(1, 0, req("merge"))).toBe("Merge i-0? Reply yes or no.");
  (r.store.intents.get("i-0") as unknown as { a: number | null }).a = 0;
  expect(await exec.answer(true)).toBe(`I didn't merge i-0: ${line}.`);
  expect(r.calls).toEqual([]);
});

test("shadow: pause on an a0 intent needs the owner's request", async () => {
  const r = world();
  const exec = r.exec();
  // On its own, or without naming the intent, the shadow may not pause it.
  expect(await exec.request(1, 0, req("pause"), "what is going on?")).toBe(`I didn't pause i-0: ${line}.`);
  expect(await exec.request(1, 1, req("pause"), "pause it")).toBe(`I didn't pause i-0: ${line}.`);
  expect(r.calls).toEqual([]);
  // Asked for by name, it is allowed without a yes, and recorded.
  expect(await exec.request(2, 0, req("pause"), "please pause i-0")).toBe("pause done");
  expect(r.calls).toEqual(["pause i-0"]);
  expect(outcomes(r).at(-1)).toEqual({ action: "pause", outcome: "done" });
});

test("shadow: the shadow cannot resume an a0 intent", async () => {
  const r = world();
  expect(await r.exec().request(1, 0, req("resume"), "resume i-0")).toBe(
    "I can't “resume”: that isn't something I'm allowed to do.",
  );
  expect(r.calls).toEqual([]);
});

test("shadow: pause on an ordinary intent is free", async () => {
  const r = world();
  (r.store.intents.get("i-0") as unknown as { a: number | null }).a = 3;
  expect(await r.exec().request(1, 0, req("pause"))).toBe("pause done");
});

test("shadow: an a0 intent is refused", async () => {
  const r = world(["merge", "boost", "drop"]);
  const exec = r.exec();
  for (const [i, action] of ["reply", "start", "confirm", "merge", "boost", "drop"].entries()) {
    expect(await exec.request(1, i, req(action, { text: "ok" }))).toBe(`I didn't ${action} i-0: ${line}.`);
  }
  expect(r.calls).toEqual([]);
  expect(outcomes(r).every((o) => o.outcome === "refused")).toBe(true);
});
