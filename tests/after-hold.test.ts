// A mission waits at build for the intents its intent file says it comes `after` (LOOP-117..119): the real
// loop and database with faked stage handlers, and `renderStatus` on a small database.

import { expect, test } from "vitest";
import { afterState, HOLD_SECONDS, heldText, holdTrigger, nextHold } from "../src/after.ts";
import { Db } from "../src/db.ts";
import type { Handlers } from "../src/handlers.ts";
import { apply, ORDER, ok, wait } from "../src/machine.ts";
import { insertMission, type Mission } from "../src/mission.ts";
import { renderStatus } from "../src/status.ts";
import { intent, TARGET } from "./helpers/flows.ts";
import { Pipe } from "./helpers/pipe.ts";
import { at, listing } from "./intents/fixtures.ts";

const A = "261026-1000";
const B = "261026-1001";
const C = "261026-1002";
const D = "261026-1003";
const GONE = "261001-0000";

/** B and D are parked (priority 3, under the cutoff of 5): they stay unfinished and are never picked. */
const PARKED = new Set([B, D]);

function files(...ids: string[]) {
  return Object.fromEntries(
    ids.map((id) => [
      `intents/${id}-t${id.slice(-1)}/intent.md`,
      intent({
        title: `T${id.slice(-1)}`,
        repo: "web",
        u: PARKED.has(id) ? 1 : 4,
        i: PARKED.has(id) ? 1 : 4,
        extra: "",
      }),
    ]),
  );
}

/** Build runs are recorded in `built`; `ask` intents first ask a question. */
function fakes(built: string[], ask = new Set<string>()): Handlers {
  const h = {
    step: async (_cx: unknown, m: Mission) => {
      if (m.stage === "pick" || m.stage === "design") return { done: ok() };
      if (m.stage === "plan") return { done: wait("approve plan") };
      if (m.stage === "build") {
        if (ask.delete(m.intent)) return { done: wait("answer the question", "a question") };
        built.push(m.intent);
        return { poll: 30 };
      }
      return { done: ok() };
    },
    finish: async () => ({ done: ok() }),
  };
  return Object.fromEntries(ORDER.filter((s) => s !== "done").map((s) => [s, h])) as Handlers;
}

const byIntent = (p: Pipe, id: string) =>
  p.db.all<Mission>("SELECT * FROM missions WHERE intent = ? ORDER BY id", id)[0]!;
const dataOfIntent = (p: Pipe, id: string) => JSON.parse(byIntent(p, id).data) as Record<string, unknown>;
const approvePlan = (p: Pipe, id: string) => p.loop.move(byIntent(p, id), { event: "plan_merged" });
const rows = (p: Pipe, id: string, like = "%") =>
  p.db.all<{ key: string }>(
    "SELECT key FROM outbox WHERE mission = ? AND key LIKE ?",
    byIntent(p, id).id,
    like,
  );
const stalled = (p: Pipe, id: string) => rows(p, id, "%dependency stalled%").length;

async function pass(p: Pipe, n = 1) {
  for (let i = 0; i < n; i++) {
    await p.loop.pass();
    p.clock.advance(61);
  }
}

const addAfter = (p: Pipe, id: string, after: string[]) =>
  p.store.update(id, "after", (e) => e.setField("after", after));
const finish = (p: Pipe, id: string, stage = "done") =>
  p.store.update(id, stage, (e) => e.setField("stage", stage));

/** Intents designed and planned; `go` gets its plan approved, so its build starts. */
async function setup(ids: string[], built: string[], ask = new Set<string>(), workers = 2) {
  const p = new Pipe(TARGET, files(...ids));
  await p.start(
    {
      intents: { remote: "https://github.com/owner/intents.git", cutoff: 5 },
      repos: { web: { github: "owner/web", ahead: 8, workers } },
    },
    { handlers: fakes(built, ask) },
  );
  await pass(p, 8);
  return p;
}

test("loop: a mission whose intent gains an unfinished after waits at build and goes on when that intent finishes", async () => {
  const built: string[] = [];
  const p = await setup([A, B], built);
  approvePlan(p, A);
  await pass(p, 3);
  expect(built).toContain(A);
  await addAfter(p, A, [B]);
  await pass(p, 2);
  const held = built.length;
  const mails = rows(p, A).length;
  await pass(p, 4);
  // No run, no question, and status says what it waits for.
  expect(built.length).toBe(held);
  expect(byIntent(p, A).stage).toBe("build");
  expect(rows(p, A).length).toBe(mails);
  expect(dataOfIntent(p, A).afterHold).toMatchObject({ text: `waiting for ${B}: not started yet` });
  await finish(p, B);
  await pass(p, 3);
  expect(built.length).toBeGreaterThan(held);
  expect(dataOfIntent(p, A).afterHold).toBeUndefined();
  expect(byIntent(p, A).stage).toBe("build");
  expect(rows(p, A).length).toBe(mails);
});

test("loop: a build is not started while after is unfinished", async () => {
  const built: string[] = [];
  const p = await setup([A, B, C], built, new Set(), 1);
  await addAfter(p, A, [B]);
  await pass(p, 2);
  approvePlan(p, A);
  await pass(p, 4);
  expect(built).not.toContain(A);
  // The held change holds no slot: another change in the repo builds meanwhile.
  approvePlan(p, C);
  await pass(p, 4);
  expect(built).toContain(C);
  expect(built).not.toContain(A);
});

test("loop: a returning mission re-reads after before building", async () => {
  const built: string[] = [];
  const p = await setup([A, B], built, new Set([A]));
  approvePlan(p, A);
  await pass(p, 3);
  expect(byIntent(p, A).stage).toBe("blocked");
  await addAfter(p, A, [B]);
  await pass(p, 2);
  p.loop.move(byIntent(p, A), { event: "answered", text: "go on" });
  await pass(p, 4);
  expect(built).not.toContain(A);
  expect(byIntent(p, A).stage).toBe("build");
  await finish(p, B);
  await pass(p, 3);
  expect(built).toContain(A);
});

test("loop: a bad after at build waits with bad after", async () => {
  const built: string[] = [];
  const p = await setup([A, B], built);
  approvePlan(p, A);
  await pass(p, 3);
  await addAfter(p, A, [GONE]);
  await pass(p, 3);
  const m = byIntent(p, A);
  expect(m.stage).toBe("blocked");
  expect(m.waiting).toBe("bad after:");
  expect(m.why).toBe(GONE);
});

test("loop: a mission with an open code PR is not held by after", async () => {
  const built: string[] = [];
  const p = await setup([A, B], built);
  approvePlan(p, A);
  await pass(p, 3);
  p.db.run("UPDATE missions SET pr = 5 WHERE id = ?", byIntent(p, A).id);
  await addAfter(p, A, [B]);
  const before = built.length;
  await pass(p, 4);
  expect(built.length).toBeGreaterThan(before);
  expect(dataOfIntent(p, A).afterHold).toBeUndefined();
});

test("loop: a rolled back dependency shows one needs-you card", async () => {
  const built: string[] = [];
  const p = await setup([A, B], built);
  approvePlan(p, A);
  await pass(p, 3);
  await addAfter(p, A, [B]);
  await p.store.update(B, "rolled back", (e) => e.setField("waiting", "rolled back, revise"));
  await pass(p, 3);
  expect(byIntent(p, A).stage).toBe("blocked");
  expect(byIntent(p, A).waiting).toBe("dependency stalled");
  expect(byIntent(p, A).why).toBe(`${B} was rolled back`);
  await pass(p, 3);
  await p.reopen();
  await pass(p, 3);
  expect(stalled(p, A)).toBe(1);
});

test("loop: a dropped dependency shows one needs-you card", async () => {
  const built: string[] = [];
  const p = await setup([A, B], built);
  approvePlan(p, A);
  await pass(p, 3);
  await addAfter(p, A, [B]);
  await finish(p, B, "dropped");
  await pass(p, 3);
  expect(byIntent(p, A).waiting).toBe("dependency stalled");
  expect(byIntent(p, A).why).toBe(`${B} was dropped`);
  await pass(p, 3);
  expect(stalled(p, A)).toBe(1);
});

test("loop: a dependency unfinished after 3 days shows one needs-you card", async () => {
  const built: string[] = [];
  const p = await setup([A, B], built);
  approvePlan(p, A);
  await pass(p, 3);
  await addAfter(p, A, [B]);
  await pass(p, 2);
  p.clock.advance(3 * 86400);
  await pass(p, 3);
  expect(byIntent(p, A).waiting).toBe("dependency stalled");
  expect(byIntent(p, A).why).toBe(`${B} is still not started yet after 3 days`);
  await pass(p, 3);
  await p.reopen();
  await pass(p, 3);
  expect(stalled(p, A)).toBe(1);
});

test("loop: a held mission asks nothing before 3 days", async () => {
  const built: string[] = [];
  const p = await setup([A, B], built);
  approvePlan(p, A);
  await pass(p, 3);
  await addAfter(p, A, [B]);
  await pass(p, 2);
  p.clock.advance(2 * 86400);
  await pass(p, 3);
  expect(byIntent(p, A).stage).toBe("build");
  expect(stalled(p, A)).toBe(0);
});

test("loop: the card of a held mission goes when the dependency is done", async () => {
  const built: string[] = [];
  const p = await setup([A, B], built);
  approvePlan(p, A);
  await pass(p, 3);
  await addAfter(p, A, [B]);
  await finish(p, B, "dropped");
  await pass(p, 3);
  expect(byIntent(p, A).stage).toBe("blocked");
  // The owner takes the dropped intent out of `after:`: the card goes and the build goes on.
  await addAfter(p, A, []);
  const before = built.length;
  await pass(p, 4);
  expect(byIntent(p, A).stage).toBe("build");
  expect(built.length).toBeGreaterThan(before);
  expect(stalled(p, A)).toBe(1);
});

const NOW = 1_793_000_000;

/** A mission in `web` taken `oks` steps along its way (3 = build). */
function mission(db: Db, id: string, oks: number, data: Record<string, unknown> = {}) {
  const cx = { db, now: NOW, subject: () => ({ title: "t", repo: "web", link: null }) };
  let m = db.tx(() => insertMission(db, { intent: id, slug: "x", repo: "web", model: "opus", a: 3 }, NOW));
  for (let i = 0; i < oks; i++) m = apply(cx, m, { event: "ok" });
  db.run("UPDATE missions SET data = ? WHERE id = ?", JSON.stringify(data), m.id);
  return db.get<Mission>("SELECT * FROM missions WHERE id = ?", m.id)!;
}

function status(db: Db) {
  return renderStatus({
    db,
    listing: listing([A, B, C].map((id) => at(`intents/${id}-x`, "", "web", `T${id.slice(-1)}`))),
    listingError: null,
    running: 1,
    version: "1",
    now: NOW,
    problems: [],
    next: "next: nothing can run now",
    prLink: () => null,
    queued: new Set(),
    workers: () => 1,
  });
}

test("status: a mission held by after names the intent it waits for", () => {
  const db = Db.memory();
  const open = [B, C].map((id) => ({ id, where: "your steps" }));
  mission(db, A, 3, { idle: true, afterHold: { since: NOW, list: [B, C], text: heldText(open) } });
  const text = status(db);
  expect(text).toContain("waiting for other intents:");
  expect(text).toContain(`- ${A} web: T0 · waiting for ${B}: your steps (+1 more)`);
  expect(text).not.toContain("working:\n-");
});

test("status: a mission held by after is not listed as needing the owner", () => {
  const db = Db.memory();
  mission(db, A, 3, {
    idle: true,
    afterHold: { since: NOW, list: [B], text: `waiting for ${B}: not started yet` },
  });
  const text = status(db);
  expect(text).not.toContain("waiting on you:");
  expect(text).not.toContain("waiting for a build slot");
  expect(text).toContain("build slots: web 0 of 1 used, 1 waiting outside slots");
});

test("after: the hold reads the listing, restarts the 3 days only for an added ID", () => {
  const l = listing([
    at(`intents/${A}-x`, `after: [${B}, ${D}]\n`, "web", "T0"),
    at(`intents/${B}-x`, "", "web", "T1"),
  ]);
  l.doneIds.add(D);
  const s = afterState(l, { id: A, after: [B, D] });
  expect(s.blockers).toEqual([{ id: B, where: "not started yet" }]);
  const first = nextHold(undefined, [B, D], heldText(s.blockers), 100);
  expect(nextHold(first, [B], first.text, 200).since).toBe(100);
  expect(nextHold(first, [B, C], first.text, 200).since).toBe(200);
  expect(holdTrigger(first, s, 100 + HOLD_SECONDS - 1)).toBeNull();
  expect(holdTrigger(first, s, 100 + HOLD_SECONDS)).toContain(B);
  expect(holdTrigger({ ...first, notified: true }, s, 100 + HOLD_SECONDS)).toBeNull();
});
