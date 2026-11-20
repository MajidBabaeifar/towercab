// The pick decision (LOOP-5): PRI-4 order, parked last, skips, waits written without a mission,
// orphaned stages, and `towercab next`'s text.

import { expect, test } from "vitest";
import { badAfter, decide, heldBack, nextText, orphans, type PickState, type Places } from "../src/pick.ts";
import { at, listing } from "./intents/fixtures.ts";

/** A repo's intents ahead: `ids` work first, then wait on the owner. */
function places(limit: number, ids: string[], working = ids.length, ownerLimit = 4): Places {
  return { working, owner: ids.length - working, limit, ownerLimit, ids };
}

function state(repos: string[], o: Partial<PickState> = {}): PickState {
  return {
    cutoff: 7,
    paused: false,
    blocked: null,
    repos: new Set(repos),
    full: new Map(),
    cooling: new Map(),
    active: new Set(),
    defaultModel: "opus",
    ...o,
  };
}

test("pick: order and skips", () => {
  const l = listing([
    at("intents/261001-0900-old", "", "web", "Old"),
    at("intents/261002-0900-big", "u: 5\ni: 5\n", "web", "Big"),
    at("intents/261003-0900-mid", "u: 5\ni: 4\n", "api", "Mid"),
    at("intents/261000-0900-mid2", "u: 5\ni: 4\n", "api", "Mid2"),
  ]);
  const d = decide(l, state(["web", "api"]));
  expect(d.pick?.id).toBe("261002-0900");
  expect(d.skipped).toEqual([]);
  // A full repo: same priority → the oldest ID.
  const full = decide(l, state(["web", "api"], { full: new Map([["web", places(1, ["261002-0900"])]]) }));
  expect(full.pick?.id).toBe("261000-0900");
  expect(full.skipped).toEqual([
    { id: "261002-0900", reason: "repo has 1 intents working ahead (start 261002-0900 to go now)" },
  ]);
  // An intent with an unfinished mission is never picked again.
  expect(decide(l, state(["web", "api"], { active: new Set(["261002-0900"]) })).pick?.id).toBe("261000-0900");

  const m = listing([
    at("intents/261001-0900-web", "u: 5\ni: 5\n", "web", "Web"),
    at("intents/261001-0901-api", "u: 4\ni: 4\nmodel: sonnet\n", "api", "Api"),
    at("intents/261001-0902-cli", "", "cli", "Cli"),
  ]);
  const all = ["web", "api", "cli"];
  for (const [o, reason] of [
    [{ paused: true }, "paused"],
    [{ blocked: "GitHub unreachable since 10:02" }, "GitHub unreachable since 10:02"],
  ] as const) {
    const d = decide(m, state(all, o));
    expect(d.pick).toBeNull();
    expect(d.skipped).toEqual(["261001-0900", "261001-0901", "261001-0902"].map((id) => ({ id, reason })));
  }
  // A model cooling down: its intents wait, others run.
  const cool = decide(m, state(all, { cooling: new Map([["opus", "15:30"]]) }));
  expect(cool.pick?.id).toBe("261001-0901");
  expect(cool.skipped).toEqual([{ id: "261001-0900", reason: "opus cooling until 15:30" }]);
  expect(decide(listing([]), state(all))).toEqual({ pick: null, skipped: [], writes: [] });

  // `towercab next`: the pick and why, then each skipped one with its reason.
  expect(nextText(cool, m, 7)).toBe(
    "next: 261001-0901 api: Api · p12 u4 i4 · highest priority that can run\n" +
      "skipped: 261001-0900 web: Web · opus cooling until 15:30\n",
  );
  expect(nextText(decide(m, state(all, { paused: true })), m, 7)).toMatch(
    /^next: nothing can run now\nskipped: /,
  );
  expect(nextText(decide(listing([]), state(all)), listing([]), 7)).toBe("next: nothing open\n");
});

test("pick: parked waits", () => {
  // p = 2i + u: 9 (u3 i3) is at the cutoff 7; 5 (u1 i2) is parked even when older.
  const l = listing([
    at("intents/260901-0900-parked", "u: 1\ni: 2\n", "web", "Parked"),
    at("intents/261005-0900-plain", "", "api", "Plain"),
  ]);
  expect(decide(l, state(["web", "api"])).pick?.id).toBe("261005-0900");
  // The important one skipped (its repo full): the parked one still waits, listed why.
  const d = decide(l, state(["web", "api"], { full: new Map([["api", places(1, ["261005-0900"])]]) }));
  expect(d.pick).toBeNull();
  expect(d.skipped).toEqual([
    { id: "261005-0900", reason: "repo has 1 intents working ahead (start 261005-0900 to go now)" },
    { id: "260901-0900", reason: "parked (p5 < 7): raise u or i to run it" },
  ]);
  expect(nextText(d, l, 7)).toContain(
    "skipped: 260901-0900 web: Parked · parked (p5 < 7): raise u or i to run it\n",
  );
  // A parked intent's unknown repo writes no wait.
  const only = listing([at("intents/260901-0900-parked", "u: 1\ni: 1\n", "nowhere", "Parked")]);
  const o = decide(only, state(["web"]));
  expect([o.pick, o.writes]).toEqual([null, []]);
  // Raising u or i un-parks it.
  const raised = listing([at("intents/260901-0900-parked", "u: 3\ni: 3\n", "web", "Parked")]);
  expect(decide(raised, state(["web"])).pick?.id).toBe("260901-0900");
  // A lower cutoff un-parks it too.
  expect(decide(l, state(["web"], { cutoff: 5 })).pick?.id).toBe("260901-0900");
});

test("pick: bad after", () => {
  const l = listing([
    at("intents/261001-0900-unknown", "after: [260101-0101]\n", "web"),
    at("intents/261001-0901-dropped", "after: [260901-0900]\n", "web"),
    at("intents/261001-0902-a", "after: [261001-0903]\n", "web"),
    at("intents/261001-0903-b", "after: [261001-0902]\n", "web"),
    at("intents/261001-0904-self", "after: [261001-0904]\n", "web"),
    at("intents/261001-0905-fine", "after: [260902-0900]\n", "web"),
    at("intents/261001-0906-waits", "after: [261001-0905]\n", "web"),
    at("intents/261001-0907-two", "after: [260101-0102, 260101-0101, 260902-0900]\n", "web"),
    at("done/260901-0900-gone", "stage: dropped\n", "web"),
    at("done/260902-0900-did", "stage: done\n", "web"),
  ]);
  expect(badAfter(l).sort((a, b) => (a.id < b.id ? -1 : 1))).toEqual([
    { id: "261001-0900", ids: ["260101-0101"] },
    { id: "261001-0901", ids: ["260901-0900"] },
    { id: "261001-0902", ids: ["261001-0903"] },
    { id: "261001-0903", ids: ["261001-0902"] },
    { id: "261001-0904", ids: ["261001-0904"] },
    { id: "261001-0907", ids: ["260101-0101", "260101-0102"] },
  ]);
  const d = decide(l, state(["web"]));
  expect(d.pick?.id).toBe("261001-0905");
  expect(d.writes).toContainEqual({
    id: "261001-0907",
    waiting: "bad after:",
    why: "260101-0101, 260101-0102",
  });
  expect(d.skipped).toContainEqual({ id: "261001-0907", reason: "bad after: 260101-0101, 260101-0102" });
  expect(d.writes.map((w) => w.id).sort()).toEqual([
    "261001-0900",
    "261001-0901",
    "261001-0902",
    "261001-0903",
    "261001-0904",
    "261001-0907",
  ]);
  // A legacy ID is done.
  const legacy = listing(
    [at("intents/261001-0900-x", "after: [250101-0101]\n", "web")],
    "- 250101-0101 web: old\n",
  );
  expect(badAfter(legacy)).toEqual([]);
  expect(decide(legacy, state(["web"])).pick?.id).toBe("261001-0900");
  // Waiting already: not queued, not written again.
  const asked = listing([
    at("intents/261001-0900-x", 'after: [260101-0101]\nwaiting: "bad after:"\n', "web"),
  ]);
  expect(decide(asked, state(["web"])).writes).toEqual([]);
});

test("pick: unknown repo", () => {
  const l = listing([
    at("intents/261001-0900-lost", "u: 5\ni: 5\n", "nowhere", "Lost"),
    at("intents/261001-0901-found", "", "web", "Found"),
  ]);
  const d = decide(l, state(["web"]));
  expect(d.pick?.id).toBe("261001-0901");
  expect(d.writes).toEqual([{ id: "261001-0900", waiting: "unknown repo", why: "nowhere" }]);
  expect(d.skipped).toEqual([{ id: "261001-0900", reason: "unknown repo nowhere" }]);
});

test("pick: orphaned stage is cleared", () => {
  const l = listing([
    at("intents/261001-0900-orphan", "stage: code\n", "web"),
    at("intents/261001-0901-busy", "stage: plan\n", "web"),
    at("intents/261001-0902-asks", "u: 1\ni: 1\nstage: code\nwaiting: call me\n", "web"),
    at("intents/261001-0903-v1", "stage: deploy\n", "web"),
    at("intents/261001-0904-fresh", "", "web"),
  ]);
  // Busy ones keep their stage; one waiting on the owner keeps it until the owner answers.
  expect(orphans(l, new Set(["261001-0901"])).sort()).toEqual(["261001-0900", "261001-0903"]);
  // Not picked while staged; once the stage is cleared it is picked again.
  expect(decide(l, state(["web"])).pick?.id).toBe("261001-0904");
  const cleared = listing([at("intents/261001-0900-orphan", "", "web")]);
  expect(decide(cleared, state(["web"])).pick?.id).toBe("261001-0900");
});

test("pick: start goes first and over the ahead limit", () => {
  const l = listing([
    at("intents/261002-0900-big", "u: 5\ni: 5\n", "web", "Big"),
    at("intents/261001-0900-small", "u: 3\ni: 3\n", "web", "Small"),
  ]);
  const full = new Map([["web", places(3, ["261002-0900", "261002-0901", "261002-0902"])]]);
  expect(decide(l, state(["web"], { full })).pick).toBeNull();
  const d = decide(l, state(["web"], { full, started: new Set(["261001-0900"]) }));
  expect(d.pick?.id).toBe("261001-0900");
  // Other skips still apply to a started intent.
  expect(decide(l, state(["web"], { paused: true, started: new Set(["261001-0900"]) })).pick).toBeNull();
});

const I = (id: string, scores: string) => at(`intents/${id}-x`, scores, "web", id);

test("pick: heldBack counts only working intents and stops at owner_waits", () => {
  const ids = ["261001-0001", "261001-0002", "261001-0003"];
  const l = listing([...ids.map((id) => I(id, "u: 4\ni: 4\n")), I("261002-0001", "u: 4\ni: 4\n")]);
  const x = l.open.find((i) => i.id === "261002-0001")!;
  // Three waiting on the owner take no place.
  expect(heldBack(places(3, ids, 0), x, l)).toBeNull();
  // Three working take all of them; a tie does not outrank.
  expect(heldBack(places(3, ids), x, l)).toEqual({ kind: "working", working: 3, limit: 3 });
  // Waiting intents add nothing to the working count: three working and three waiting hold by `ahead`.
  const six = [...ids, "261001-0004", "261001-0005", "261001-0006"];
  expect(heldBack(places(3, six, 3), x, l)).toEqual({ kind: "working", working: 3, limit: 3 });
  // At `owner_waits` the owner-waits limit holds, whatever else is ahead.
  expect(heldBack(places(3, six, 2, 4), x, l)).toEqual({ kind: "owner", owner: 4, limit: 4 });
  expect(heldBack(places(3, six, 0, 6), x, l)).toEqual({ kind: "owner", owner: 6, limit: 6 });
  // Nothing ahead, or an unknown repo: nothing holds it.
  expect(heldBack(places(3, []), x, l)).toBeNull();
  expect(heldBack(undefined, x, l)).toBeNull();
});

test("pick: an intent that outranks every intent ahead is never held", () => {
  const ids = ["261001-0001", "261001-0002"];
  const l = listing([...ids.map((id) => I(id, "u: 4\ni: 4\n")), I("261002-0001", "u: 5\ni: 5\n")]);
  const top = l.open.find((i) => i.id === "261002-0001")!;
  // Full of working intents: the higher priority starts.
  expect(heldBack(places(1, ids), top, l)).toBeNull();
  // But it does not pass `owner_waits` (LOOP-132).
  expect(heldBack(places(1, ids, 0, 2), top, l)).toEqual({ kind: "owner", owner: 2, limit: 2 });
  const d = decide(l, state(["web"], { full: new Map([["web", places(1, ids)]]) }));
  expect(d.pick?.id).toBe("261002-0001");
  // The others are held, with their reason.
  expect(d.skipped.map((s) => s.reason)).toEqual([]);
  const d2 = decide(
    l,
    state(["web"], { active: new Set(["261002-0001"]), full: new Map([["web", places(1, ids)]]) }),
  );
  expect(d2.pick).toBeNull();
  expect(d2.skipped[0]!.reason).toBe("repo has 2 intents working ahead (start 261001-0001 to go now)");
});
