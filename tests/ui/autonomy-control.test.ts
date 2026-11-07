// UI-257, UI-258: the autonomy control's data on the page and cards, a refused change, the Activity entry
// and the flag card that counts as needing the owner.

import { afterEach, expect, test } from "vitest";
import { recordChange } from "../../src/autonomy-change.ts";
import { startUi } from "../../src/ui/server.ts";
import { activity, intentPage, overview } from "../../src/ui/state.ts";
import { buildFixture, type Fixture, flagScene, IDS } from "../../ui/fixture.ts";
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

test("ui: autonomy shows the current level and the repo cap", async () => {
  const f = world();
  const i = f.store.open.find((x) => x.id === IDS.plan)!;
  i.a = 3;
  const page = (await intentPage(f.sources, IDS.plan))!;
  expect(page.autonomy).toMatchObject({ a: 3, cap: null, locked: false });
  expect(page.autonomy!.notes).toHaveLength(6);
  // A card carries the same control; an intent with no `a` shows its default (a5, a4 for others' intents).
  const cards = (await overview({ ...f.sources, clock: { now: () => NOW, mono: () => 0 } })).needs;
  expect(cards.find((c) => c.intent === IDS.plan)!.autonomy).toMatchObject({ a: 3 });
  const bare = (await intentPage(f.sources, IDS.question))!;
  expect(bare.autonomy!.a).toBe(f.store.open.find((x) => x.id === IDS.question)!.a ?? 5);
  // The repo's cap, once Towercab has read it, shows beside the control.
  f.db.setMeta(`a-cap:${i.repo}`, "2");
  expect((await intentPage(f.sources, IDS.plan))!.autonomy!.cap).toBe(2);
});

test("ui: a refused autonomy change keeps the old level", async () => {
  const f = world();
  const { ui, port } = await serve(f);
  const i = f.store.open.find((x) => x.id === IDS.upnext)!;
  i.a = 2;
  const r = await post(port, ui.token, { action: "autonomy", id: IDS.upnext, a: 0, actor: "owner" });
  expect(r.status).toBe(422);
  expect(JSON.parse(r.body)).toEqual({ ok: false, message: "The intents repo refused the push." });
  expect((await intentPage(f.sources, IDS.upnext))!.autonomy!.a).toBe(2);
  // A level outside 0-5, and an unknown intent, are refused too.
  expect((await post(port, ui.token, { action: "autonomy", id: "261026-0000-9", a: 3 })).status).toBe(422);
  expect((await post(port, ui.token, { action: "autonomy", id: IDS.upnext, a: 9 })).status).toBe(422);
  const ok = await post(port, ui.token, { action: "autonomy", id: IDS.upnext, a: 4, actor: "owner" });
  expect(JSON.parse(ok.body)).toEqual({ ok: true, message: "Saved. Applies from the next gate." });
});

test("ui: an autonomy change shows in activity", async () => {
  const f = world();
  recordChange(f.db, { intent: IDS.plan, from: 3, to: 4, at: NOW - 60 });
  const items = (await activity(f.sources, { kind: "settings" })).items;
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ kind: "settings", intent: IDS.plan, text: "a: a3 → a4" });
  const page = (await intentPage(f.sources, IDS.plan))!;
  expect(page.timeline.map((t) => t.text)).toContain("You changed autonomy from a3 to a4 on the page");
});

test("ui: a flagged raise shows a card naming who raised it", async () => {
  const f = world();
  flagScene(f);
  const cards = (await overview({ ...f.sources, clock: { now: () => NOW, mono: () => 0 } })).needs;
  const card = cards.find((c) => c.kind === "autonomy")!;
  expect(card.intent).toBe(IDS.plan);
  expect(card.why).toContain("mallory raised");
  expect(card.why).toContain("from a2 to a5");
  expect(card.why).toContain("It still runs at a2 until you decide.");
  expect(card.autonomy).toMatchObject({ a: 2, flag: { who: "mallory", from: 2, to: 5 } });
  const page = (await intentPage(f.sources, IDS.plan))!;
  expect(page.autonomy!.flag).toMatchObject({ who: "mallory" });
});

test("ui: the flag card counts as needing you", async () => {
  const f = world();
  const sources = { ...f.sources, clock: { now: () => NOW, mono: () => 0 } };
  const before = (await overview(sources)).top.needs;
  flagScene(f);
  expect((await overview(sources)).top.needs).toBe(before + 1);
  // Setting it back ends the flag and the card goes.
  await f.actions.autonomy!(IDS.plan, 2);
  expect((await overview(sources)).top.needs).toBe(before);
});
