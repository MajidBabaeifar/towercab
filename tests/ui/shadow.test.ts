// UI-236 to UI-238: the shadow's tag, its recent actions and Reset, on the page's data.

import { afterEach, expect, test } from "vitest";
import { startUi } from "../../src/ui/server.ts";
import { shadowView } from "../../src/ui/shadow.ts";
import { intentPage, overview } from "../../src/ui/state.ts";
import { buildFixture, type Fixture, IDS, seedShadow } from "../../ui/fixture.ts";
import { call, post } from "./http.ts";

const made: Fixture[] = [];
afterEach(() => {
  while (made.length) made.pop()!.cleanup();
});

function world(shadow: boolean) {
  const now = Date.now() / 1000;
  const f = buildFixture({ now });
  made.push(f);
  if (shadow) seedShadow(f, now);
  return { f, now };
}

test("ui: shadow actions are tagged on the timeline and cards", async () => {
  const { f } = world(true);
  // A draft of the shadow's shows the tag on its page and in the queue.
  const page = await intentPage(f.sources, IDS.upnext);
  expect(page?.shadow).toBe(true);
  const moves = page!.timeline.filter((t) => t.shadow);
  expect(moves.map((t) => t.text)).toEqual([`[shadow] Drafted ${IDS.upnext}`]);
  const ov = await overview(f.sources);
  expect([...ov.working, ...ov.queued].filter((r) => r.shadow).map((r) => r.intent)).toContain(IDS.upnext);
  // An intent that isn't the shadow's has none.
  expect((await intentPage(f.sources, IDS.ci))?.shadow).toBeUndefined();
  // The refused and the held ones show on the timeline of what they touched.
  const plan = await intentPage(f.sources, IDS.plan);
  expect(
    plan!.timeline.some((t) => t.text.startsWith("[shadow] Waiting for your yes in Telegram: merge")),
  ).toBe(true);
});

test("ui: shadow panel lists recent actions with links", async () => {
  const { f, now } = world(true);
  const v = shadowView({ ...f.sources, clock: { now: () => now, mono: () => 0 } });
  expect(v.enabled).toBe(true);
  expect(v.actions.map((a) => `${a.outcome}: ${a.text}`)).toEqual([
    `refused: Didn't start ${IDS.queued}: it has already started`,
    `held: Waiting for your yes in Telegram: merge ${IDS.plan}`,
    `done: Replied on ${IDS.question}`,
    `done: Drafted ${IDS.upnext}`,
  ]);
  expect(v.actions[0]!.intent).toBe(IDS.queued);
  expect(v.pending).toEqual([{ action: "merge", intent: IDS.plan }]);
  expect(v.spentUsd).toBeCloseTo(1.25);
  expect(v.cap).toBe("$5.00");
  // The same through the API, and the page's version moves when the shadow acts.
  const ui = startUi({
    port: 0,
    sources: f.sources,
    actions: f.actions,
    distDir: "/nonexistent",
    log: () => {},
  });
  const port = await ui.ready;
  try {
    const r = await call(port, { path: "/api/shadow" });
    expect(r.status).toBe(200);
    expect((JSON.parse(r.body) as { actions: unknown[] }).actions).toHaveLength(4);
    const before = (JSON.parse((await call(port, { path: "/api/state" })).body) as { version: string })
      .version;
    f.db.run(
      "INSERT INTO shadow_actions (at, action, intent, outcome) VALUES (?, 'start', ?, 'done')",
      now,
      IDS.queued,
    );
    const after = (JSON.parse((await call(port, { path: "/api/state" })).body) as { version: string })
      .version;
    expect(after).not.toBe(before);
    // UI-238: Reset goes through the actions endpoint.
    const reset = await post(port, ui.token, { action: "shadowReset" });
    expect(reset.status).toBe(200);
    expect(JSON.parse(reset.body)).toEqual({
      ok: true,
      message: "Cleared the shadow's conversation. Its log of actions stays.",
    });
  } finally {
    await ui.stop();
  }
});

test("ui: shadow panel is hidden when off", async () => {
  const { f, now } = world(false);
  const v = shadowView({ ...f.sources, clock: { now: () => now, mono: () => 0 } });
  expect(v.enabled).toBe(false);
  expect(v.actions).toEqual([]);
  expect(f.sources.config.shadow.enabled).toBe(false);
});
