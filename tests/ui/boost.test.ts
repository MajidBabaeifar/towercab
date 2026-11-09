// UI-205, UI-207, UI-208: the Boost button on the plane card, why a boosted plane waits, and the worker's
// note that it lowered the level.

import { afterEach, expect, test } from "vitest";
import { RAISE_NOTES } from "../../src/autonomy.ts";
import { Db } from "../../src/db.ts";
import type { Intent, IntentStore } from "../../src/intents/types.ts";
import { createActions } from "../../src/ui/actions.ts";
import { startUi } from "../../src/ui/server.ts";
import { intentPage, overview } from "../../src/ui/state.ts";
import { buildFixture, type Fixture, IDS } from "../../ui/fixture.ts";
import { post } from "./http.ts";

const NOW = new Date(2026, 9, 26, 23, 0, 0).getTime() / 1000;
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

function world() {
  const f = buildFixture({ now: NOW });
  cleanup.push(() => f.cleanup());
  return f;
}

async function serve(f: Fixture) {
  const ui = startUi({
    port: 0,
    sources: f.sources,
    actions: f.actions,
    distDir: f.root,
    log: () => {},
    pollMs: 20,
  });
  cleanup.push(() => ui.stop());
  return { ui, port: await ui.ready };
}

const intent = (f: Fixture, id: string) => f.store.open.find((x) => x.id === id)!;
const sources = (f: Fixture) => ({ ...f.sources, clock: { now: () => NOW, mono: () => 0 } });
const plane = async (f: Fixture, id: string) =>
  (await overview(sources(f))).airspace.planes.find((p) => p.intent === id)!;

/** The page's real actions over a store that holds one intent. */
function realActions(found: Partial<Intent>) {
  const db = Db.memory();
  const intent = { id: IDS.upnext, done: false, source: "me", ...found };
  const store = { get: async () => intent } as unknown as IntentStore;
  const actions = createActions({
    db,
    store,
    config: undefined as never,
    clock: { now: () => NOW, mono: () => 0 },
    github: { owner: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }) },
  });
  return { db, actions };
}

test("ui: boost appears on the plane card for an own intent below a5", async () => {
  const f = world();
  intent(f, IDS.upnext).a = 3;
  const p = await plane(f, IDS.upnext);
  expect(p.controls).toMatchObject({ canBoost: true });
  // An unstarted intent at a5 is still offered Boost: it starts it now.
  intent(f, IDS.upnext).a = 5;
  expect((await plane(f, IDS.upnext)).controls!.canBoost).toBe(true);
});

test("ui: boost asks for a confirmation that names a5", async () => {
  const f = world();
  intent(f, IDS.upnext).a = 3;
  const note = (await plane(f, IDS.upnext)).controls!.boostNote;
  // The a5 note of the raise confirm (UI-257), and for an unstarted intent that it starts now.
  expect(note).toContain(RAISE_NOTES[5]);
  expect(note).toContain("It also starts now.");
  intent(f, IDS.building).a = 3;
  const running = (await plane(f, IDS.building)).controls!.boostNote;
  expect(running).toBe(RAISE_NOTES[5]);
});

test("ui: boost on an unstarted intent starts it", async () => {
  const { db, actions } = realActions({ a: 2 });
  expect(await actions.boost!(IDS.upnext, "owner")).toBe("Boosted: a5 and design started.");
  const row = db.get<{ name: string; arg: string; source: string }>("SELECT * FROM commands");
  expect(row).toMatchObject({ name: "boost", arg: IDS.upnext, source: "ui" });
  // The page reaches it too.
  const f = world();
  const { ui, port } = await serve(f);
  const r = await post(port, ui.token, { action: "boost", id: IDS.upnext, actor: "owner" });
  expect(JSON.parse(r.body).ok).toBe(true);
  expect(f.calls).toContainEqual({ action: "boost", intent: IDS.upnext });
  expect(intent(f, IDS.upnext).a).toBe(5);
});

test("ui: boost is not shown for another source", async () => {
  const f = world();
  intent(f, IDS.upnext).source = "observer";
  expect((await plane(f, IDS.upnext)).controls!.canBoost).toBe(false);
  const { db, actions } = realActions({ source: "observer" });
  await expect(actions.boost!(IDS.upnext, "owner")).rejects.toThrow("a5 is only for your own intents.");
  expect(db.get("SELECT * FROM commands")).toBeUndefined();
});

test("ui: boost is not shown at a5 for a started intent", async () => {
  const f = world();
  intent(f, IDS.building).a = 5;
  expect((await plane(f, IDS.building)).controls!.canBoost).toBe(false);
  intent(f, IDS.building).a = 3;
  expect((await plane(f, IDS.building)).controls!.canBoost).toBe(true);
});

test("ui: a boosted plane says it waits for high risk", async () => {
  const f = world();
  intent(f, IDS.question).a = 5;
  const card = (await overview(sources(f))).needs.find((c) => c.intent === IDS.question)!;
  const why = (await plane(f, IDS.question)).controls!.waitWhy;
  // The reason is the one the card already gives; the plane only repeats it.
  expect(why).toBe(`Waiting because: ${(card.why || card.ask).replace(/\.$/, "")}`);
  // A plane below a5 says nothing of the kind.
  intent(f, IDS.question).a = 3;
  expect((await plane(f, IDS.question)).controls!.waitWhy).toBeNull();
});

test("ui: a boosted plane says the repo cap holds it", async () => {
  const f = world();
  intent(f, IDS.question).a = 5;
  f.db.setMeta(`a-cap:${intent(f, IDS.question).repo}`, "3");
  const page = (await intentPage(f.sources, IDS.question))!;
  expect(page.controls!.waitWhy).toBe("Waiting because the repo caps autonomy at a3");
  expect((await plane(f, IDS.question)).controls!.waitWhy).toBe(
    "Waiting because the repo caps autonomy at a3",
  );
});

test("ui: a boosted plane says it waits for access", async () => {
  const f = world();
  intent(f, IDS.plan).a = 5;
  expect((await plane(f, IDS.plan)).controls!.waitWhy).toBe("Waiting for a decision on access");
});

test("ui: a card shows that the worker lowered autonomy and why", async () => {
  const f = world();
  intent(f, IDS.building).a = 3;
  intent(f, IDS.building).lowerWhy = "It touches the billing tables.";
  const page = (await intentPage(f.sources, IDS.building))!;
  expect(page.controls!.lowered).toBe("Lowered to a3 by the worker: It touches the billing tables.");
  expect((await plane(f, IDS.building)).controls!.lowered).toBe(page.controls!.lowered);
});

test("ui: a boost clears the lowered note", async () => {
  const f = world();
  const { ui, port } = await serve(f);
  intent(f, IDS.building).a = 3;
  intent(f, IDS.building).lowerWhy = "It touches the billing tables.";
  await post(port, ui.token, { action: "boost", id: IDS.building, actor: "owner" });
  const page = (await intentPage(f.sources, IDS.building))!;
  expect(page.controls!.lowered).toBeNull();
});

test("ui: a later lowering after a boost shows its own note", async () => {
  const f = world();
  const { ui, port } = await serve(f);
  await post(port, ui.token, { action: "boost", id: IDS.building, actor: "owner" });
  intent(f, IDS.building).a = 2;
  intent(f, IDS.building).lowerWhy = "A second look found a migration.";
  const page = (await intentPage(f.sources, IDS.building))!;
  expect(page.controls!.lowered).toBe("Lowered to a2 by the worker: A second look found a migration.");
});
