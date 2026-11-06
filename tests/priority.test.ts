// Scores, order, cutoff, the picker's list, dropping (PRI-1..6, PRI-9).

import { join } from "node:path";
import { expect, test } from "vitest";
import { IntentFile, parseIntent } from "../src/intents/intent.ts";
import { openStore } from "../src/intents/store.ts";
import { todoView } from "../src/intents/views.ts";
import {
  cmpIntents,
  DEFAULT_SCORE,
  isParked,
  isQueued,
  parseScores,
  pickOrder,
  priority,
  priorityOf,
} from "../src/priority.ts";
import { FakeTools } from "./helpers/tools.ts";
import { bareRepo, git, tempDir } from "./helpers/world.ts";
import { at, ids, intentMd, listing } from "./intents/fixtures.ts";

test("priority: scores are 1 to 5", () => {
  for (const [extra, err] of [
    ["u: 0\n", "u must be an integer 1-5"],
    ["u: 6\n", "u must be an integer 1-5"],
    ["i: 7\n", "i must be an integer 1-5"],
    ["a: 6\n", "a must be an integer 0-5"],
    ["u: -1\n", "u must be an integer 1-5"],
    ["u: x\n", "u must be an integer 1-5"],
    ["i: 2.5\n", "i must be an integer 1-5"],
    ['u: "3"\n', "u must be an integer 1-5"],
  ]) {
    expect(() => parseIntent(intentMd("towercab", extra!, "X")), extra).toThrow(err);
  }
  for (let n = 1; n <= 5; n++) {
    const i = parseIntent(intentMd("towercab", `u: ${n}\ni: ${n}\na: ${n}\n`, "X"));
    expect([i.u, i.i, i.a]).toEqual([n, n, n]);
  }
  // Writes check the same; a refused one changes nothing.
  const f = IntentFile.parse(intentMd("towercab", "u: 4\n", "X"));
  const before = f.render();
  for (const [key, n] of [
    ["u", 0],
    ["i", 6],
    ["a", -1],
    ["u", 2.5],
  ] as const) {
    expect(() => f.setField(key, n)).toThrow(`${key} must be an integer ${key === "a" ? "0-5" : "1-5"}`);
    expect(f.render()).toBe(before);
  }
  // Score words for `add`: `[uia][1-5]`, each key at most once.
  expect(parseScores(["u4", "i5", "a3"])).toEqual({ u: 4, i: 5, a: 3 });
  expect(parseScores(["i1"])).toEqual({ i: 1 });
  expect(parseScores([])).toEqual({});
  const bad = (s: string) => `bad score "${s}": want uN, iN or aN with N 1-5, each once`;
  for (const s of ["u0", "u6", "i9", "a0", "x3", "u", "u33", "4u", "U4", "u3 ", "", "uu", "u-1", "u٣"]) {
    expect(() => parseScores([s]), s).toThrow(bad(s));
  }
  expect(() => parseScores(["u3", "i2", "u4"])).toThrow(bad("u4"));
  expect(() => parseScores(["a2", "a2"])).toThrow(bad("a2"));
});

test("priority: missing scores count as 3", () => {
  expect(DEFAULT_SCORE).toBe(3);
  expect(priority(null, null)).toBe(9);
  expect(priority(undefined, undefined)).toBe(priority(3, 3));
  expect(priority(5, null)).toBe(11);
  expect(priority(null, 1)).toBe(5);
  // Applied on read: the fields stay missing, `a` too.
  const bare = at("intents/261020-0721-bare");
  expect([bare.u, bare.i, bare.a]).toEqual([null, null, null]);
  const l = listing([at("intents/261020-0722-nine", "u: 3\ni: 3\n"), bare]);
  expect(ids(l.open)).toEqual(["261020-0721", "261020-0722"]);
  expect(todoView(l, 7)).toContain("towercab: 261020-0721-bare · p9 u3 i3\n");
});

test("priority: score is 2i + u", () => {
  for (let u = 1; u <= 5; u++) for (let i = 1; i <= 5; i++) expect(priority(u, i)).toBe(2 * i + u);
  expect(priority(1, 1)).toBe(3);
  expect(priority(5, 5)).toBe(15);
  // Importance weighs double; `a` plays no part.
  expect(priority(1, 4)).toBeGreaterThan(priority(5, 1));
  expect(priorityOf(at("intents/261020-0721-x", "u: 4\ni: 5\na: 1\n"))).toBe(14);
});

test("priority: order is priority then age", () => {
  const list = [
    at("intents/261020-0722-c", "u: 4\ni: 5\n"),
    at("intents/261020-0721-10-ten", "u: 4\ni: 5\n"),
    at("intents/251231-2359-low", "u: 1\ni: 1\n"),
    at("intents/261020-0721-2-two", "u: 4\ni: 5\n"),
    at("intents/261021-0000-eleven", "u: 1\ni: 5\n"),
    at("intents/261020-0721-one", "u: 4\ni: 5\n"),
    at("intents/261019-2359-older", "u: 4\ni: 5\n"),
    at("intents/250101-0000-nine", ""),
    at("intents/261020-0900-eleven2", "u: 3\ni: 4\n"),
  ].sort(cmpIntents);
  expect(ids(list)).toEqual([
    "261019-2359",
    "261020-0721",
    "261020-0721-2",
    "261020-0721-10",
    "261020-0722",
    "261020-0900",
    "261021-0000",
    "250101-0000",
    "251231-2359",
  ]);
  for (const a of list) {
    expect(cmpIntents(a, a)).toBe(0);
    for (const b of list) expect(Math.sign(cmpIntents(a, b)) + Math.sign(cmpIntents(b, a))).toBe(0);
  }
});

test("priority: parked intents wait", () => {
  for (let cutoff = 1; cutoff <= 15; cutoff++) {
    for (let p = 3; p <= 15; p++) expect(isParked(p, cutoff)).toBe(p < cutoff);
  }
  // Cutoff 7: i >= 3 never parked; i2 needs u >= 3; i1 needs u5.
  for (let u = 1; u <= 5; u++) {
    for (let i = 1; i <= 5; i++) {
      expect(isParked({ u, i }, 7)).toBe((i === 2 && u < 3) || (i === 1 && u < 5));
    }
  }
  // An old parked intent waits for a new one at the cutoff; parked ones come last, still listed.
  const l = listing([
    at("intents/250101-0000-old-parked", "u: 1\ni: 1\n"),
    at("intents/250101-0001-old-parked-2", "u: 2\ni: 2\n"),
    at("intents/261021-0900-new", "u: 1\ni: 3\n"),
  ]);
  expect(ids(pickOrder(l, 7))).toEqual(["261021-0900", "250101-0001", "250101-0000"]);
  expect(ids(pickOrder(l, 1))).toEqual(["261021-0900", "250101-0001", "250101-0000"]);
  expect(ids(pickOrder(l, 8))).toEqual(["261021-0900", "250101-0001", "250101-0000"]);
  // The cutoff moves the line in TODO.md.
  expect(todoView(l, 8)).toContain("## Parked\n\n- [261021-0900]");
  expect(todoView(l, 7)).toContain("## Next\n\n- [261021-0900]");
  expect(pickOrder(listing([]), 7)).toEqual([]);
});

test("priority: after waits for done", () => {
  const l = listing(
    [
      at("intents/261020-0700-top", "u: 5\ni: 5\n"),
      at("intents/261020-0701-staged", "u: 5\ni: 5\nstage: spec\n"),
      at("intents/261020-0702-waiting", "u: 5\ni: 5\nwaiting: answer the question\n"),
      at("intents/261020-0703-blocked", "u: 5\ni: 5\nafter: [261020-0700]\n"),
      at("intents/261020-0704-unknown", "u: 5\ni: 5\nafter: [251010-1010]\n"),
      at(
        "intents/261020-0707-unblocked",
        "u: 3\ni: 4\nafter: [261019-0900, 261015-1446, 261019-1200, 261019-1300]\n",
      ),
      at("intents/261020-0708-parked", "u: 2\ni: 2\n"),
      at("intents/261020-0709-at-cutoff", "u: 1\ni: 3\n"),
      // A dropped prerequisite never meets an `after`.
      at("intents/261020-0710-after-dropped-in-place", "u: 5\ni: 5\nafter: [261019-0900, 261019-1000]\n"),
      at("intents/261020-0711-after-dropped", "u: 5\ni: 5\nafter: [261019-1100]\n"),
      at("done/261019-0900-shipped", "stage: done\n"),
      at("intents/261019-1000-dropped-in-place", "stage: dropped\n"),
      at("done/261019-1100-dropped", "stage: dropped\n"),
      at("done/261019-1200-moved-by-hand", ""),
      at("intents/261019-1300-done-in-place", "stage: done\n"),
    ],
    "2026-10-15 261015-1446 towercab: Rename · towercab#5\n",
  );
  expect(ids(pickOrder(l, 7))).toEqual(["261020-0700", "261020-0707", "261020-0709", "261020-0708"]);
  expect(isQueued(l.open.find((i) => i.id === "261020-0700")!)).toBe(true);
  expect(isQueued(l.open.find((i) => i.id === "261020-0701")!)).toBe(false);
  expect(isQueued(l.open.find((i) => i.id === "261020-0702")!)).toBe(false);
  expect([...l.doneIds].sort()).toEqual(["261015-1446", "261019-0900", "261019-1200", "261019-1300"]);
  expect([...l.droppedIds].sort()).toEqual(["261019-1000", "261019-1100"]);
  const todo = todoView(l, 7);
  expect(todo).toContain("after-dropped-in-place · p15 u5 i5 · after 261019-1000\n");
  expect(todo).toContain("after-dropped · p15 u5 i5 · after 261019-1100\n");
  expect(todo).toContain("unblocked · p11 u3 i4\n");
  expect(todo).toContain("blocked · p15 u5 i5 · after 261020-0700\n");
});

test("priority: TODO shows the order", () => {
  const texts = [
    at("intents/261020-0900-low", "u: 1\ni: 1\n", "towercab", "Low"),
    at("intents/261020-0800-mid", "u: 3\ni: 3\n", "towercab", "Mid"),
    at("intents/261020-0700-top", "u: 4\ni: 5\n", "towercab", "Top"),
    at("intents/261020-0600-parked", "u: 2\ni: 2\n", "towercab", "Parked"),
  ];
  const l = listing(texts);
  expect(ids(l.open)).toEqual(["261020-0700", "261020-0800", "261020-0600", "261020-0900"]);
  const todo = todoView(l, 7);
  const pos = (s: string) => todo.indexOf(s);
  expect(pos("## Next")).toBeLessThan(pos("towercab: Top · p14"));
  expect(pos("towercab: Top · p14")).toBeLessThan(pos("towercab: Mid · p9"));
  expect(pos("towercab: Mid · p9")).toBeLessThan(pos("## Parked"));
  expect(pos("## Parked")).toBeLessThan(pos("towercab: Parked · p6"));
  expect(pos("towercab: Parked · p6")).toBeLessThan(pos("towercab: Low · p3"));
  // A rescore moves it on the next read; the order is never in the file.
  const raised = listing([
    at("intents/261020-0900-low", "u: 5\ni: 5\n", "towercab", "Low"),
    ...texts.slice(1),
  ]);
  expect(ids(raised.open)).toEqual(["261020-0900", "261020-0700", "261020-0800", "261020-0600"]);
  expect(texts[0]!.text).toBe(intentMd("towercab", "u: 1\ni: 1\n", "Low"));
});

test("priority: drop moves the intent to done", async () => {
  const remote = bareRepo({
    "intents/261020-0722-drop/intent.md": intentMd("towercab", "u: 4\n", "Drop it"),
    "intents/261020-0722-drop/plan.md": "# Plan\n",
  });
  const now = new Date(2026, 9, 21, 12, 0, 0);
  const store = await openStore({
    remote,
    path: join(tempDir(), "intents"),
    tools: new FakeTools(),
    now: () => now,
  });
  const got = await store.update("0722", "drop", (e) => e.setField("stage", "dropped"));
  expect(got).toMatchObject({ dir: "done/261020-0722-drop", done: true, stage: "dropped" });
  expect(got.finished?.slice(0, 19)).toBe("2026-10-21T12:00:00");
  const l = await store.list();
  expect(l.open).toEqual([]);
  expect(ids(l.done)).toEqual(["261020-0722"]);
  expect(l.droppedIds.has("261020-0722") && !l.doneIds.has("261020-0722")).toBe(true);
  expect(git(remote, "log", "-1", "--format=%s", "main").trim()).toBe("towercab: drop 261020-0722");
  expect(git(remote, "show", "main:done/261020-0722-drop/plan.md")).toBe("# Plan\n");
  expect(git(remote, "show", "main:DONE.md")).toContain(
    "- 2026-10-21 [261020-0722](done/261020-0722-drop/intent.md) towercab: Drop it · dropped\n",
  );
  await expect(store.get("0722")).rejects.toThrow("no open intent matches 0722");
});
