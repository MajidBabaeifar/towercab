// UI-203, UI-204, UI-206: urgency and importance on the intent page, the scores action, and the highest
// autonomy level offered for an intent that isn't the owner's own.

import { afterEach, expect, test } from "vitest";
import { Db } from "../../src/db.ts";
import type { Intent, IntentStore } from "../../src/intents/types.ts";
import { createActions } from "../../src/ui/actions.ts";
import { startUi } from "../../src/ui/server.ts";
import { intentPage } from "../../src/ui/state.ts";
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

test("ui: the intent page changes urgency and importance", async () => {
  const f = world();
  const { ui, port } = await serve(f);
  intent(f, IDS.upnext).u = 3;
  intent(f, IDS.upnext).i = 3;
  const page = (await intentPage(f.sources, IDS.upnext))!;
  expect(page.controls).toMatchObject({ u: 3, i: 3, priority: 9, parked: false });
  const r = await post(port, ui.token, { action: "scores", id: IDS.upnext, u: 5, i: 4, actor: "owner" });
  expect(JSON.parse(r.body)).toMatchObject({ ok: true, message: "Saved. The queue is reordered." });
  expect((await intentPage(f.sources, IDS.upnext))!.controls).toMatchObject({ u: 5, i: 4, priority: 13 });
  // One score alone leaves the other as it is.
  await post(port, ui.token, { action: "scores", id: IDS.upnext, i: 2, actor: "owner" });
  expect((await intentPage(f.sources, IDS.upnext))!.controls).toMatchObject({ u: 5, i: 2, priority: 9 });
});

test("ui: a score change shows the new priority and parked state", async () => {
  const f = world();
  const { ui, port } = await serve(f);
  const r = await post(port, ui.token, { action: "scores", id: IDS.upnext, u: 1, i: 1, actor: "owner" });
  expect(JSON.parse(r.body)).toMatchObject({ ok: true, priority: 3, parked: true });
  expect((await intentPage(f.sources, IDS.upnext))!.controls).toMatchObject({ priority: 3, parked: true });
  const back = await post(port, ui.token, { action: "scores", id: IDS.upnext, u: 5, i: 5, actor: "owner" });
  expect(JSON.parse(back.body)).toMatchObject({ priority: 15, parked: false });
});

test("ui: a refused score change keeps the old values", async () => {
  const f = world();
  const { ui, port } = await serve(f);
  const before = (await intentPage(f.sources, IDS.upnext))!.controls;
  const bad = await post(port, ui.token, { action: "scores", id: IDS.upnext, u: 9, actor: "owner" });
  expect(bad.status).toBe(422);
  expect(JSON.parse(bad.body).ok).toBe(false);
  expect((await intentPage(f.sources, IDS.upnext))!.controls).toEqual(before);
});

test("ui: scores show without controls on a done intent", async () => {
  const f = world();
  const page = (await intentPage(f.sources, IDS.done1))!;
  expect(page.controls).toBeUndefined();
  expect(page.scores).toContain("Priority");
});

test("ui: scores action writes u and i", async () => {
  const f = world();
  const { ui, port } = await serve(f);
  await post(port, ui.token, { action: "scores", id: IDS.queued, u: 4, i: 5, actor: "owner" });
  expect(f.calls).toContainEqual({ action: "scores", intent: IDS.queued, u: 4, i: 5 });
  expect(intent(f, IDS.queued)).toMatchObject({ u: 4, i: 5 });
});

test("ui: scores action refuses a bad value", async () => {
  const f = world();
  const { ui, port } = await serve(f);
  for (const body of [{ u: 0 }, { i: 6 }, { u: "3" }, { u: 2.5 }]) {
    const r = await post(port, ui.token, { action: "scores", id: IDS.queued, actor: "owner", ...body });
    expect(r.status).toBe(422);
  }
  expect(intent(f, IDS.queued)).toMatchObject({ u: 2, i: 4 });
  expect((await post(port, ui.token, { action: "scores", id: "261026-0000-9", u: 3 })).status).toBe(422);
});

test("ui: scores action needs the maintainer role", async () => {
  // Without sign-in the page is the owner's alone: any other actor, and the shadow, are refused.
  const db = Db.memory();
  const found = { id: IDS.queued, done: false, u: 2, i: 4, source: "me" } as Intent;
  const store = { get: async () => found } as unknown as IntentStore;
  const deps = {
    db,
    store,
    config: { intents: { cutoff: 7 } } as never,
    clock: { now: () => NOW, mono: () => 0 },
    github: { owner: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }) },
  };
  await expect(createActions(deps).scores!(IDS.queued, 4, null, "mallory")).rejects.toThrow(
    "only you can change scores",
  );
  await expect(createActions({ ...deps, actor: "shadow" }).scores!(IDS.queued, 4, null)).rejects.toThrow(
    "only you can change scores",
  );
});

test("ui: another source gets a0 to a4 only", async () => {
  const f = world();
  intent(f, IDS.queued).source = "observer";
  const page = (await intentPage(f.sources, IDS.queued))!;
  expect(page.autonomy!.max).toBe(4);
  expect(page.controls!.canBoost).toBe(false);
});

test("ui: an own intent gets a0 to a5", async () => {
  const f = world();
  const page = (await intentPage(f.sources, IDS.queued))!;
  expect(page.autonomy!.max).toBe(5);
});

test("ui: the api refuses a5 for another source", async () => {
  const db = Db.memory();
  const found = { id: IDS.queued, done: false, a: 2, source: "observer" } as Intent;
  const store = { get: async () => found } as unknown as IntentStore;
  const actions = createActions({
    db,
    store,
    config: undefined as never,
    clock: { now: () => NOW, mono: () => 0 },
    github: { owner: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }) },
  });
  await expect(actions.autonomy!(IDS.queued, 5, "owner")).rejects.toThrow("a5 is only for your own intents.");
});
