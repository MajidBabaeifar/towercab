// UI-192 to UI-196: Focus picks the one wait that needs the owner most, shows what is around it, and counts
// the rest.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { byFocus, focus } from "../../src/ui/focus.ts";
import { startUi } from "../../src/ui/server.ts";
import { overviewOf } from "../../src/ui/state.ts";
import { buildFixture, type Fixture, IDS, makeIntent } from "../../ui/fixture.ts";
import { tempDir } from "../helpers/world.ts";
import { call } from "./http.ts";

// Mon 26 Oct 2026, 23:00:00 local time.
const NOW = new Date(2026, 9, 26, 23, 0, 0).getTime() / 1000;
const open: (() => unknown)[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
});
function fixture(o: { proposed?: boolean; empty?: boolean } = {}): Fixture {
  const f = buildFixture({ now: NOW, ...o });
  open.push(() => f.cleanup());
  return f;
}

/** Every key Focus hands out when each is skipped in turn, in order. */
async function walk(f: Fixture): Promise<string[]> {
  const keys: string[] = [];
  for (;;) {
    const page = await focus(f.sources, keys);
    if (!page.item) return keys;
    keys.push(page.item.key);
  }
}

test("ui: focus picks the highest priority wait", async () => {
  const f = fixture();
  // The plan wait is 2i + u = 14; the code wait has waited longest but is 11.
  const page = await focus(f.sources);
  expect(page.item?.key).toBe(IDS.plan);
  expect(page.item?.card?.kind).toBe("plan");
  // A higher priority moves another intent to the front.
  const q = f.store.open.find((i) => i.id === IDS.question)!;
  q.u = 5;
  q.i = 5;
  expect((await focus(f.sources)).item?.key).toBe(IDS.question);
  // Missing scores count as 3 (PRI-3): 2 × 3 + 3 = 9, below the plan's 14.
  q.u = null;
  q.i = null;
  expect((await focus(f.sources)).item?.key).toBe(IDS.plan);
});

test("ui: focus breaks ties by oldest wait", async () => {
  const f = fixture({ proposed: true });
  // The spreadsheet proposal and the plan wait are both 14; the proposal has waited 2 days.
  expect((await focus(f.sources)).item?.key).toBe("proposed-201");
  f.state.proposed.list.find((p) => p.number === 201)!.createdAt = NOW - 60;
  expect((await focus(f.sources)).item?.key).toBe(IDS.plan);
  // Equal in everything but the key: the lower key, so the pick never flips between two reads.
  const c = (key: string) => ({ key, rank: 0, priority: 9, since: 5, item: null as never });
  expect([c("b"), c("a")].sort(byFocus).map((x) => x.key)).toEqual(["a", "b"]);
  // A wait with no known start counts as the newest.
  const unknown = { ...c("a"), since: Number.POSITIVE_INFINITY };
  expect([unknown, c("b")].sort(byFocus).map((x) => x.key)).toEqual(["b", "a"]);
});

test("ui: focus includes questions, blocked waits and proposed intents", async () => {
  const f = fixture({ proposed: true });
  const keys = await walk(f);
  // By priority (14, 14, 12, 12, 11, 11, 10, 9), oldest first inside a tie; the proposal that would be
  // parked (5) comes after every other wait.
  expect(keys).toEqual([
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
  const kinds = new Map<string, string>();
  for (const k of keys) {
    const item = (await focus(f.sources, keys.slice(0, keys.indexOf(k)))).item!;
    kinds.set(k, item.card?.kind ?? "proposed");
  }
  expect(kinds.get(IDS.plan)).toBe("plan");
  expect(kinds.get(IDS.question)).toBe("question");
  expect(kinds.get(IDS.code)).toBe("code");
  expect(kinds.get(IDS.crm)).toBe("blocked");
  expect(kinds.get("proposed-203")).toBe("proposed");
});

test("ui: focus counts the other waits without listing them", async () => {
  const f = fixture({ proposed: true });
  const page = await focus(f.sources);
  expect(page.more).toBe(8);
  // Only the one shown is in the data: no other title, no list.
  const text = JSON.stringify(page);
  for (const other of ["Export invoices as CSV", "Rewrite the getting-started guide", "Sync contacts"])
    expect(text).not.toContain(other);
  // A wait the page has just acted on is left out of the pick and the count, until it stops waiting.
  const acted = await focus(f.sources, ["proposed-201", IDS.plan, "no-such-wait"]);
  expect(acted.item?.key).toBe("proposed-205");
  expect(acted.more).toBe(6);
  expect(acted.asked).toEqual(["proposed-201", IDS.plan, "no-such-wait"]);
  expect(acted.skipped).toEqual(["proposed-201", IDS.plan]);
  // Nothing waits: no item, no count.
  const empty = await focus(fixture({ empty: true }).sources);
  expect(empty.item).toBeNull();
  expect(empty.more).toBe(0);
});

test("ui: focus shows repo, overview, history and the ask", async () => {
  const f = fixture();
  const plan = (await focus(f.sources)).item!;
  expect(plan.repo).toBe("api");
  expect(plan.title).toBe("Rate-limit the public API");
  expect(plan.overview).toBe(
    "A single client sent 40,000 requests in a minute last week and slowed the API down for everyone.",
  );
  expect(plan.history.map((h) => h.label)).toEqual(["Spec"]);
  expect(plan.history[0]!.text).toContain("600 requests a minute");
  // The ask, the plain reason and the actions are the Needs you card's own.
  expect(plan.card?.ask).toBeTruthy();
  expect(plan.card?.actions).toEqual(["merge", "retry", "drop"]);
  expect(plan.card?.mergeLabel).toBe("Merge plan PR");
  expect(plan.card?.access?.domains.length).toBe(2);
  // A question after the spec and plan: both phases are in the history, in order.
  const q = (await focus(f.sources, [IDS.plan])).item!;
  expect(q.key).toBe(IDS.question);
  expect(q.history.map((h) => h.label)).toEqual(["Spec", "Plan"]);
  expect(q.card?.question?.options.length).toBe(3);
  expect(q.card?.actions).toContain("reply");
  // Nothing finished yet or no brief stored: no history, and no invented text.
  const code = (await focus(f.sources, [IDS.plan, IDS.question])).item!;
  expect(code.key).toBe(IDS.code);
  expect(code.history).toEqual([]);
  // The overview is the first sentence only, on one line; the Why is the fallback for older intents.
  const intent = (text: string) =>
    makeIntent({ id: "261101-0900-1", title: "T", repo: "web", sections: new Map([["Problem", text]]) });
  expect(overviewOf(intent("Exports are slow.\nThey time out. Fix it."))).toBe("Exports are slow.");
  expect(overviewOf(intent("No full stop here"))).toBe("No full stop here");
  expect(overviewOf(intent("x".repeat(300)))?.length).toBe(240);
  expect(overviewOf(intent("  "))).toBeNull();
  expect(overviewOf(undefined)).toBeNull();
});

test("ui: focus shows a proposed intent", async () => {
  const f = fixture({ proposed: true });
  const item = (await focus(f.sources)).item!;
  expect(item.key).toBe("proposed-201");
  expect(item.card).toBeNull();
  expect(item.repo).toBe("web");
  expect(item.title).toBe("Export invoices as a spreadsheet");
  expect(item.proposed).toMatchObject({ pr: 201, priority: 14, canAccept: true, head: expect.any(String) });
  // One that can't be accepted from here is still a wait: it offers Close.
  const only = await focus(f.sources, (await walk(f)).slice(0, 7));
  expect(only.item?.proposed?.pr).toBe(204);
  expect(only.item?.proposed?.canAccept).toBe(false);
  // A failed read says the list may be out of date.
  f.state.proposed = { ...f.state.proposed, error: "boom", failedAt: NOW };
  expect((await focus(f.sources)).stale).toContain("this list may be out of date");
});

test("ui: focus is served from its own API", async () => {
  const f = fixture({ proposed: true });
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
  const page = await call(port, { path: "/api/focus" });
  expect(page.status).toBe(200);
  const body = JSON.parse(page.body);
  expect(Object.keys(body).sort()).toEqual([
    "asked",
    "item",
    "more",
    "readOnly",
    "skipped",
    "stale",
    "version",
  ]);
  expect(body.item.key).toBe("proposed-201");
  expect(body.more).toBe(8);
  // The page's own address serves the app, and the tab is not part of the overview's data.
  const html = await call(port, { path: "/focus" });
  expect(html.status).toBe(200);
  expect(html.headers["content-type"]).toBe("text/html; charset=utf-8");
  expect(JSON.parse((await call(port, { path: "/api/state" })).body)).not.toHaveProperty("item");
  // Skips narrow the pick; anything that isn't a plain key is ignored.
  const next = JSON.parse(
    (await call(port, { path: `/api/focus?skip=proposed-201,${IDS.plan},../x,%00,` })).body,
  );
  expect(next.item.key).toBe("proposed-205");
  expect(next.asked).toEqual(["proposed-201", IDS.plan]);
  expect((await call(port, { path: "/api/focus", method: "DELETE" })).status).toBe(405);
});
