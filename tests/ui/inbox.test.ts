// UI-259, UI-264, UI-266: the Inbox lists every wait in one order, marks what is new, keeps the owner's
// snoozes and last visit on the server, and takes Focus's old address.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Db } from "../../src/db.ts";
import { byInbox, inbox } from "../../src/ui/inbox.ts";
import { startUi } from "../../src/ui/server.ts";
import { overview, overviewOf } from "../../src/ui/state.ts";
import { buildFixture, type Fixture, IDS, makeIntent } from "../../ui/fixture.ts";
import { tempDir } from "../helpers/world.ts";
import { call, post } from "./http.ts";

// Mon 26 Oct 2026, 23:00:00 local time.
const NOW = new Date(2026, 9, 26, 23, 0, 0).getTime() / 1000;
const HOUR = 3600;
const open: (() => unknown)[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
});
function fixture(o: { proposed?: boolean; empty?: boolean; crowded?: boolean } = {}): Fixture {
  const f = buildFixture({ now: NOW, ...o });
  open.push(() => f.cleanup());
  return f;
}

async function serve(f: Fixture) {
  const d = tempDir("tc-dist-");
  mkdirSync(join(d, "assets"));
  writeFileSync(
    join(d, "index.html"),
    '<!doctype html><meta name="towercab-token" content=""><title>T</title>',
  );
  const ui = startUi({
    port: 0,
    sources: f.sources,
    actions: f.actions,
    distDir: d,
    log: () => {},
    pollMs: 20,
  });
  open.push(() => ui.stop());
  const port = await ui.ready;
  return { ui, port };
}

const keys = async (f: Fixture) => (await inbox(f.sources)).items.map((i) => i.key);
/** Moves the fixture's clock; it is fixed at NOW unless a test says so. */
const setNow = (f: Fixture, t: number) => {
  (f.sources.clock as { now: () => number }).now = () => t;
};

/** The wait of an intent ends: its mission is done and its file no longer says it waits. */
function end(f: Fixture, id: string) {
  f.db.run("UPDATE missions SET stage = 'done', finished = 1 WHERE intent = ?", id);
  f.store.open.find((i) => i.id === id)!.waiting = null;
}

test("ui: the inbox lists every wait in priority order", async () => {
  const f = fixture({ proposed: true });
  // By priority (14, 14, 12, 12, 11, 11, 10, 9), oldest first inside a tie; the proposal that would be
  // parked (5) comes after every other wait (UI-193).
  expect(await keys(f)).toEqual([
    "proposed-201",
    IDS.plan,
    "proposed-205",
    IDS.question,
    "proposed-202",
    IDS.code,
    IDS.crm,
    "proposed-204",
    "proposed-203",
  ]);
  const items = (await inbox(f.sources)).items;
  const kind = (k: string) => items.find((i) => i.key === k)!;
  expect(kind(IDS.plan).card?.kind).toBe("plan");
  expect(kind(IDS.question).card?.kind).toBe("question");
  expect(kind(IDS.code).card?.kind).toBe("code");
  expect(kind(IDS.crm).card?.kind).toBe("blocked");
  expect(kind("proposed-203").proposed?.pr).toBe(203);
  // A higher priority moves another intent to the front; missing scores count as 3 (PRI-3).
  const plain = fixture();
  const q = plain.store.open.find((i) => i.id === IDS.question)!;
  expect((await keys(plain))[0]).toBe(IDS.plan);
  q.u = 5;
  q.i = 5;
  expect((await keys(plain))[0]).toBe(IDS.question);
  // The oldest wait comes first between equals.
  f.state.proposed.list.find((p) => p.number === 201)!.createdAt = NOW - 60;
  expect((await keys(f)).slice(0, 2)).toEqual([IDS.plan, "proposed-201"]);
  const c = (key: string, since = 5) => ({ key, rank: 0, priority: 9, since, item: null as never });
  expect([c("b"), c("a")].sort(byInbox).map((x) => x.key)).toEqual(["a", "b"]);
  expect([c("a", Number.POSITIVE_INFINITY), c("b")].sort(byInbox).map((x) => x.key)).toEqual(["b", "a"]);
});

test("ui: the inbox shows the repo, overview, history and the ask of each item", async () => {
  const f = fixture({ proposed: true });
  const items = (await inbox(f.sources)).items;
  const plan = items.find((i) => i.key === IDS.plan)!;
  expect(plan.repo).toBe("api");
  expect(plan.overview).toBe(
    "A single client sent 40,000 requests in a minute last week and slowed the API down for everyone.",
  );
  expect(plan.history.map((h) => h.label)).toEqual(["Spec"]);
  expect(plan.card?.actions).toEqual(["merge", "retry", "drop"]);
  expect(plan.merge).toBe(true);
  expect(plan.pr).toBe(plan.card?.pr?.number);
  expect(items.find((i) => i.key === IDS.question)!.history.map((h) => h.label)).toEqual(["Spec", "Plan"]);
  expect(items.find((i) => i.key === IDS.question)!.merge).toBe(false);
  const proposed = items.find((i) => i.key === "proposed-201")!;
  expect(proposed.card).toBeNull();
  expect(proposed.proposed).toMatchObject({ pr: 201, priority: 14, canAccept: true });
  expect(proposed.pr).toBe(201);
  const intent = (text: string) =>
    makeIntent({ id: "261101-0900-1", title: "T", repo: "web", sections: new Map([["Problem", text]]) });
  expect(overviewOf(intent("Exports are slow.\nThey time out. Fix it."))).toBe("Exports are slow.");
  f.state.proposed = { ...f.state.proposed, error: "boom", failedAt: NOW };
  expect((await inbox(f.sources)).stale).toContain("this list may be out of date");
});

test("ui: the inbox count equals the needs count", async () => {
  for (const f of [fixture({ proposed: true }), fixture({ crowded: true }), fixture({ empty: true })]) {
    const page = await inbox(f.sources);
    const o = await overview(f.sources);
    expect(page.needs).toBe(o.top.needs);
    expect(page.items.length).toBe(o.top.needs);
  }
  // A snoozed item is still one of them (UI-264).
  const f = fixture({ proposed: true });
  const { ui, port } = await serve(f);
  const r = await post(port, ui.token, { action: "snooze", item: IDS.plan, until: NOW + HOUR });
  expect(r.status).toBe(200);
  const page = JSON.parse((await call(port, { path: "/api/inbox" })).body);
  expect(page.needs).toBe(9);
  expect(page.items.length).toBe(9);
});

test("ui: the inbox moves on when a wait ends", async () => {
  const f = fixture();
  const first = (await keys(f))[0];
  expect(first).toBe(IDS.plan);
  // The owner acted: the card lingers until the loop moves, but it is no longer a wait (UI-105).
  end(f, IDS.plan);
  const after = await keys(f);
  expect(after).not.toContain(IDS.plan);
  expect(after[0]).toBe(IDS.question);
  const empty = await inbox(fixture({ empty: true }).sources);
  expect(empty.items).toEqual([]);
  expect(empty.needs).toBe(0);
});

test("ui: the first visit marks nothing new", async () => {
  const f = fixture({ proposed: true });
  const page = await inbox(f.sources);
  expect(page.lastVisit).toBeNull();
  expect(page.items.some((i) => i.new)).toBe(false);
});

test("ui: a wait newer than the last visit is marked new", async () => {
  const f = fixture({ proposed: true });
  const plan = (await inbox(f.sources)).items.find((i) => i.key === IDS.plan)!;
  // The visit falls between two waits: those that began after it are new, the older ones are not.
  f.db.setMeta("inbox:last_visit", String(plan.since! + 1));
  const page = await inbox(f.sources);
  expect(page.lastVisit).toBe(plan.since! + 1);
  const fresh = page.items.filter((i) => i.new).map((i) => i.key);
  expect(fresh.length).toBeGreaterThan(0);
  expect(fresh).not.toContain(IDS.plan);
  for (const i of page.items) expect(i.new).toBe(i.since !== null && i.since > plan.since! + 1);
});

test("ui: the last visit is set on the server after the page was visible for 3 seconds", async () => {
  const f = fixture({ proposed: true });
  const { ui, port } = await serve(f);
  // The page waits 3 s before it sends `seen`; the server stamps its own clock, not the page's.
  const r = await post(port, ui.token, { action: "seen", until: 1 });
  expect(r.status).toBe(200);
  expect((await inbox(f.sources)).lastVisit).toBe(NOW);
  setNow(f, NOW + 500);
  await post(port, ui.token, { action: "seen" });
  const page = JSON.parse((await call(port, { path: "/api/inbox" })).body);
  expect(page.lastVisit).toBe(NOW + 500);
  expect(page.items.some((i: { new: boolean }) => i.new)).toBe(false);
});

test("ui: a snoozed item moves under snoozed and returns when due", async () => {
  const f = fixture({ proposed: true });
  const { ui, port } = await serve(f);
  await post(port, ui.token, { action: "seen" });
  const r = await post(port, ui.token, { action: "snooze", item: IDS.plan, until: NOW + HOUR });
  expect(JSON.parse(r.body).ok).toBe(true);
  let plan = (await inbox(f.sources)).items.find((i) => i.key === IDS.plan)!;
  expect(plan.snoozedUntil).toBe(NOW + HOUR);
  expect(plan.new).toBe(false);
  // Due: it is back in the list, marked new until the owner next looks.
  setNow(f, NOW + HOUR + 1);
  plan = (await inbox(f.sources)).items.find((i) => i.key === IDS.plan)!;
  expect(plan.snoozedUntil).toBeNull();
  expect(plan.new).toBe(true);
  await post(port, ui.token, { action: "seen" });
  plan = (await inbox(f.sources)).items.find((i) => i.key === IDS.plan)!;
  expect(plan.new).toBe(false);
  // Unsnoozing puts it back at once.
  await post(port, ui.token, { action: "snooze", item: IDS.plan, until: NOW + 2 * HOUR + 1 });
  expect((await inbox(f.sources)).items.find((i) => i.key === IDS.plan)!.snoozedUntil).not.toBeNull();
  await post(port, ui.token, { action: "unsnooze", item: IDS.plan });
  expect((await inbox(f.sources)).items.find((i) => i.key === IDS.plan)!.snoozedUntil).toBeNull();
  // A snooze whose wait ended is dropped.
  await post(port, ui.token, { action: "snooze", item: IDS.plan, until: NOW + 3 * HOUR });
  end(f, IDS.plan);
  await inbox(f.sources);
  expect(f.db.meta(`inbox:snooze:${IDS.plan}`)).toBeNull();
});

test("ui: a snooze is shared between two clients", async () => {
  const f = fixture({ proposed: true });
  const { ui, port } = await serve(f);
  const version = JSON.parse((await call(port, { path: "/api/inbox" })).body).version;
  await post(port, ui.token, { action: "snooze", item: "proposed-201", until: NOW + HOUR });
  // Another browser reads the same server: the item is snoozed there too, and the version moved.
  const other = JSON.parse((await call(port, { path: "/api/inbox", headers: { Cookie: "x=1" } })).body);
  expect(other.items.find((i: { key: string }) => i.key === "proposed-201").snoozedUntil).toBe(NOW + HOUR);
  expect(other.version).not.toBe(version);
  expect((await overview(f.sources)).version).not.toBe(
    (await overview(fixture({ proposed: true }).sources)).version,
  );
});

test("ui: a snooze in the past or beyond 30 days is refused", async () => {
  const f = fixture({ proposed: true });
  const { ui, port } = await serve(f);
  const snooze = async (item: string, until: unknown) =>
    JSON.parse((await post(port, ui.token, { action: "snooze", item, until })).body);
  expect(await snooze(IDS.plan, NOW - 1)).toEqual({ ok: false, message: "That time has already passed." });
  expect(await snooze(IDS.plan, NOW + 31 * 86_400)).toEqual({
    ok: false,
    message: "A snooze can last 30 days at most.",
  });
  expect((await snooze(IDS.plan, "soon")).ok).toBe(false);
  expect((await snooze("no-such-item", NOW + HOUR)).message).toBe("That isn't waiting on you now.");
  expect((await snooze(IDS.plan, NOW + 30 * 86_400)).ok).toBe(true);
  expect((await snooze("", NOW + HOUR)).message).toBe("Which item?");
});

test("ui: a snoozed item still counts as needing you", async () => {
  const f = fixture({ proposed: true });
  const before = (await overview(f.sources)).top.needs;
  const { ui, port } = await serve(f);
  await post(port, ui.token, { action: "snooze", item: IDS.plan, until: NOW + HOUR });
  const o = await overview(f.sources);
  expect(o.top.needs).toBe(before);
  expect(o.airspace.counts.needs).toBe(before);
  expect((await inbox(f.sources)).needs).toBe(before);
});

test("ui: inbox state survives a restart and an older database gains it", async () => {
  const f = fixture();
  const { ui, port } = await serve(f);
  await post(port, ui.token, { action: "seen" });
  await post(port, ui.token, { action: "snooze", item: IDS.plan, until: NOW + HOUR });
  // The state is in the database file, so a new process reads it back.
  const again = new Db(f.home.db);
  open.push(() => again.close());
  const reread = await inbox({ ...f.sources, db: again });
  expect(reread.lastVisit).toBe(NOW);
  expect(reread.items.find((i) => i.key === IDS.plan)!.snoozedUntil).toBe(NOW + HOUR);
  // A database from before the Inbox has none of it, and needs no migration to get it.
  const old = fixture();
  expect(old.db.meta("inbox:last_visit")).toBeNull();
  const page = await inbox(old.sources);
  expect(page.lastVisit).toBeNull();
  expect(page.items.every((i) => !i.new && i.snoozedUntil === null)).toBe(true);
  const { ui: u2, port: p2 } = await serve(old);
  expect(JSON.parse((await post(p2, u2.token, { action: "seen" })).body).ok).toBe(true);
  expect(old.db.meta("inbox:last_visit")).toBe(String(NOW));
});

test("ui: focus redirects to the inbox", async () => {
  const f = fixture({ proposed: true });
  const { port } = await serve(f);
  for (const path of ["/focus", "/focus/"]) {
    const r = await call(port, { path });
    expect(r.status, path).toBe(302);
    expect(r.headers.location).toBe("/");
  }
  // The new addresses serve the app; the old API is gone.
  for (const path of ["/", "/overview", "/inbox", `/inbox/${IDS.plan}`, "/inbox/proposed-201"]) {
    const r = await call(port, { path });
    expect(r.status, path).toBe(200);
    expect(r.headers["content-type"]).toBe("text/html; charset=utf-8");
  }
  expect((await call(port, { path: "/api/focus" })).status).toBe(404);
  const body = JSON.parse((await call(port, { path: "/api/inbox" })).body);
  expect(Object.keys(body).sort()).toEqual(["items", "lastVisit", "needs", "readOnly", "stale", "version"]);
  expect((await call(port, { path: "/api/inbox", method: "DELETE" })).status).toBe(405);
  expect(JSON.parse((await call(port, { path: "/api/state" })).body)).not.toHaveProperty("items");
});
