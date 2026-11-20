// Changing an intent's urgency and importance (LOOP-133) and boosting it to a5 (LOOP-134): one commit that
// touches only the lines named, nothing restarted, and the gates that still hold after a boost.

import { join } from "node:path";
import { expect, test } from "vitest";
import { effectiveA, riskWaits } from "../src/autonomy.ts";
import { applyCommand, type CommandName, ignoredNotes } from "../src/commands.ts";
import { Db } from "../src/db.ts";
import { openStore } from "../src/intents/store.ts";
import type { Intent, IntentStore } from "../src/intents/types.ts";
import { insertMission, unfinishedFor } from "../src/mission.ts";
import { effectiveOf, intentOf } from "../src/pipeline/common.ts";
import { isParked, pickOrder } from "../src/priority.ts";
import type { RepoFiles } from "../src/repo/files.ts";
import { changeScores, scoreChanges, scoreWords } from "../src/scores.ts";
import { FakeTools } from "./helpers/tools.ts";
import { bareRepo, git, tempDir } from "./helpers/world.ts";
import { intentMd } from "./intents/fixtures.ts";

const ID = "261107-0900";
const OTHER = "261107-0901";
const file = (extra: string, title = "Thing") => intentMd("web", extra, title);
const NOW = 1_793_000_000;

async function world(extra = "u: 3\ni: 3\na: 2\n", otherExtra = "u: 3\ni: 3\n") {
  const remote = bareRepo({
    [`intents/${ID}-thing/intent.md`]: file(extra),
    [`intents/${OTHER}-other/intent.md`]: file(otherExtra, "Other"),
  });
  const store = await openStore({
    remote,
    path: join(tempDir(), "intents"),
    tools: new FakeTools(),
    log: () => {},
    now: () => new Date(NOW * 1000),
  });
  const db = Db.memory();
  const applyCtx = { db, now: NOW, subject: () => ({ title: "t", repo: "web", link: null }) };
  const cx = { db, store, applyCtx, now: new Date(NOW * 1000), cutoff: 7 };
  const text = (id = ID, slug = "thing") => git(remote, "show", `main:intents/${id}-${slug}/intent.md`);
  const commits = () => Number(git(remote, "rev-list", "--count", "main").trim());
  let n = 0;
  const run = (name: CommandName, arg: string, source: string, body = "") =>
    applyCommand(cx, {
      id: ++n,
      name,
      arg,
      text: body,
      source,
      created: NOW,
      applied_at: null,
      result: null,
    });
  const change = (c: { u?: number; i?: number }, id = ID) =>
    changeScores({ db, store, now: NOW, cutoff: 7 }, id, c, "ui");
  return { remote, store, db, cx, text, commits, run, change };
}

test("scores: changing u and i writes only those lines in one commit", async () => {
  const w = await world();
  const before = w.commits();
  const r = await w.change({ u: 5, i: 4 });
  expect(r).toMatchObject({ changed: true, priority: 13, parked: false });
  expect(w.commits()).toBe(before + 1);
  expect(w.text()).toBe(file("u: 5\ni: 4\na: 2\n"));
  const diff = git(w.remote, "diff", "--numstat", "HEAD~1", "HEAD", "--", `intents/${ID}-thing/intent.md`);
  expect(diff.trim()).toBe(`2\t2\tintents/${ID}-thing/intent.md`);
});

test("scores: setting the same values writes nothing", async () => {
  const w = await world();
  const before = w.commits();
  const r = await w.change({ u: 3, i: 3 });
  expect(r.changed).toBe(false);
  expect(w.commits()).toBe(before);
  // A missing score counts as 3: writing 3 is no change, writing another value is.
  const bare = await world("a: 2\n");
  const n = bare.commits();
  expect((await bare.change({ u: 3 })).changed).toBe(false);
  expect(bare.commits()).toBe(n);
  expect((await bare.change({ u: 4 })).changed).toBe(true);
  expect(bare.text()).toContain("u: 4\n");
  expect(bare.text()).not.toContain("i:");
});

test("scores: a value outside 1 to 5 is refused", async () => {
  const w = await world();
  const before = w.commits();
  await expect(w.change({ u: 6 })).rejects.toThrow("Urgency is 1 to 5.");
  await expect(w.change({ i: 0 })).rejects.toThrow("Importance is 1 to 5.");
  await expect(w.change({ u: 2.5 })).rejects.toThrow("Urgency is 1 to 5.");
  await expect(w.change({})).rejects.toThrow("Which score?");
  await expect(w.change({ u: 4 }, "261107-9999")).rejects.toThrow();
  expect(w.commits()).toBe(before);
});

test("scores: a done intent is refused", async () => {
  const w = await world();
  const done = { id: ID, done: true, u: 3, i: 3 } as Intent;
  const store = { get: async () => done } as unknown as IntentStore;
  const cx = { db: w.db, store, now: NOW, cutoff: 7 };
  await expect(changeScores(cx, ID, { u: 4 }, "ui")).rejects.toThrow(`${ID} is done or dropped`);
});

test("scores: the new priority reorders the queue on the next pass", async () => {
  const w = await world("u: 3\ni: 3\n", "u: 3\ni: 4\n");
  // OTHER outranks ID (priority 11 against 9) ...
  expect(pickOrder(await w.store.list(), 7).map((i) => i.id)).toEqual([OTHER, ID]);
  await w.change({ u: 5, i: 5 });
  // ... until ID is raised to 15.
  expect(pickOrder(await w.store.list(), 7).map((i) => i.id)).toEqual([ID, OTHER]);
});

test("scores: a score that parks an intent stops it being picked", async () => {
  const w = await world();
  const r = await w.change({ u: 1, i: 1 });
  expect(r).toMatchObject({ priority: 3, parked: true });
  const listing = await w.store.list();
  const me = listing.open.find((i) => i.id === ID)!;
  expect(isParked(me, 7)).toBe(true);
  // The picker lists it after every intent at or above the cutoff.
  expect(pickOrder(listing, 7).map((i) => i.id)).toEqual([OTHER, ID]);
});

test("scores: a running mission is not restarted by a change", async () => {
  const w = await world();
  const spec = { intent: ID, slug: "t", repo: "web", model: "opus", a: 2 };
  const m = w.db.tx(() => insertMission(w.db, spec, NOW));
  await w.change({ u: 1, i: 1 });
  const after = unfinishedFor(w.db, ID)!;
  expect(after.id).toBe(m.id);
  expect(after.stage).toBe(m.stage);
  expect(after.attempt).toBe(m.attempt);
});

test("scores: a change is on the timeline", async () => {
  const w = await world();
  await w.change({ u: 5 });
  await w.run("score", ID, "cli", "i=1");
  const rows = scoreChanges(w.db, ID);
  expect(rows.map((r) => scoreWords(r))).toEqual(["u: 3 → 5", "i: 3 → 1"]);
  expect(rows.map((r) => r.by)).toEqual(["ui", "cli"]);
});

test("boost: sets a5 and starts an unstarted intent", async () => {
  const w = await world("u: 3\ni: 3\na: 2\nlower_why: risky\n");
  const before = w.commits();
  const r = await w.run("boost", ID, "ui");
  expect(r).toBe(`boosted ${ID}: a5, and its design begins on the next pass, over the limit if need be`);
  expect(w.commits()).toBe(before + 1);
  expect(w.text()).toBe(file("u: 3\ni: 3\na: 5\n"));
  expect(w.db.meta(`start:${ID}`)).toBe("1");
});

test("boost: removes the lowered note in the same commit", async () => {
  const w = await world("u: 3\ni: 3\na: 3\nlower_why: it touches billing\n");
  const before = w.commits();
  await w.run("boost", ID, "ui");
  expect(w.commits()).toBe(before + 1);
  expect(w.text()).not.toContain("lower_why");
  expect(w.text()).toContain("a: 5\n");
});

test("boost: an intent already at a5 is only started", async () => {
  const w = await world("u: 3\ni: 3\na: 5\n");
  const before = w.commits();
  expect(await w.run("boost", ID, "ui")).toContain("its design begins on the next pass");
  expect(w.commits()).toBe(before);
  expect(w.db.meta(`start:${ID}`)).toBe("1");
});

test("boost: a started intent only gets a5", async () => {
  const w = await world();
  const spec = { intent: ID, slug: "t", repo: "web", model: "opus", a: 2 };
  w.db.tx(() => insertMission(w.db, spec, NOW));
  expect(await w.run("boost", ID, "ui")).toBe(`boosted ${ID}: a5 from its next gate`);
  expect(w.text()).toBe(file("u: 3\ni: 3\na: 5\n"));
  expect(w.db.meta(`start:${ID}`)).toBeNull();
});

test("boost: a command from the cli is dropped", async () => {
  const w = await world();
  const before = w.commits();
  expect(await w.run("boost", ID, "cli")).toBe("boost: only you can raise autonomy: use the page");
  expect(w.commits()).toBe(before);
  expect(w.db.meta(`start:${ID}`)).toBeNull();
  expect(ignoredNotes(w.db, ID).some((n) => n.text.includes('"boost" from the cli'))).toBe(true);
});

test("boost: another source is refused", async () => {
  const w = await world("u: 3\ni: 3\na: 2\nsource: observer\n");
  const before = w.commits();
  expect(await w.run("boost", ID, "ui")).toBe("boost: a5 is only for the owner's own intents");
  expect(w.commits()).toBe(before);
  expect(w.db.meta(`start:${ID}`)).toBeNull();
});

test("boost: a parked intent is started", async () => {
  const w = await world("u: 1\ni: 1\na: 2\n");
  expect(await w.run("boost", ID, "ui")).toContain("its design begins");
  expect(w.db.meta(`start:${ID}`)).toBe("1");
});

test("boost: a paused intent only gets a5", async () => {
  const w = await world();
  w.db.setMeta(`paused:${ID}`, "1");
  const said = await w.run("boost", ID, "ui");
  expect(said).toBe(`boosted ${ID}: a5; it is paused, so it starts when you resume it`);
  expect(w.text()).toBe(file("u: 3\ni: 3\na: 5\n"));
  expect(w.db.meta(`start:${ID}`)).toBeNull();
});

test("boost: the cap and the risk gate still hold", async () => {
  const w = await world();
  await w.run("boost", ID, "ui");
  const m = { intent: ID } as never;
  const intent = await intentOf({ db: w.db, store: w.store } as never, m);
  expect(intent.a).toBe(5);
  // A repo capped at a3 keeps a boosted intent at a3 (AUT-8); a high-risk change still waits at a5 (AUT-18).
  expect(effectiveOf(m, intent, { towercab: { maxAutonomy: 3 } } as unknown as RepoFiles)).toBe(3);
  expect(effectiveA(5, 3, "me")).toBe(3);
  expect(riskWaits(5, "high")).toBe(true);
  expect(riskWaits(5, "medium")).toBe(false);
});
