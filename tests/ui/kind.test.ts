// UI-283: the page shows an intent's kind and the stages it skips, and lets the owner set it.

import { afterEach, expect, test } from "vitest";
import { Db } from "../../src/db.ts";
import type { Intent, IntentStore } from "../../src/intents/types.ts";
import { insertMission } from "../../src/mission.ts";
import { createActions } from "../../src/ui/actions.ts";
import { overview } from "../../src/ui/state.ts";
import { buildFixture, type Fixture, IDS } from "../../ui/fixture.ts";

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

const intent = (f: Fixture, id: string) => f.store.open.find((x) => x.id === id)!;
const sources = (f: Fixture, running = true) => ({
  ...f.sources,
  running,
  clock: { now: () => NOW, mono: () => 0 },
});
const plane = async (f: Fixture, id: string, running = true) =>
  (await overview(sources(f, running))).airspace.planes.find((p) => p.intent === id)!;

/** The page's real actions over a store that holds one intent, optionally with a mission at `stage`. */
function realActions(found: Partial<Intent>, stage?: string) {
  const db = Db.memory();
  const it = { id: IDS.upnext, done: false, source: "me", ...found };
  if (stage) {
    const m = insertMission(
      db,
      { intent: it.id, repo: "web", slug: "x", model: "m", a: 3, minAttempt: 1 } as never,
      NOW,
    );
    db.run("UPDATE missions SET stage = ? WHERE id = ?", stage, m.id);
  }
  const store = { get: async () => it } as unknown as IntentStore;
  const actions = createActions({
    db,
    store,
    config: undefined as never,
    clock: { now: () => NOW, mono: () => 0 },
    github: { owner: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }) },
  } as never);
  return { db, actions };
}

test("ui: the intent page shows the kind and the skipped stages", async () => {
  const f = world();
  intent(f, IDS.upnext).kind = "bugfix";
  const k = (await plane(f, IDS.upnext)).controls!.kind;
  expect(k).toMatchObject({ value: "bugfix", label: "Bugfix", by: "owner", canSet: true });
  expect(k.skipped).toContain("No spec PR: this is a bugfix.");
  expect(k.options.map((o) => o.value)).toEqual(["feature", "bugfix", "refactor", "infra", "spec-only"]);
  // With no kind set, the full path shows and nothing is skipped.
  intent(f, IDS.upnext).kind = null;
  expect((await plane(f, IDS.upnext)).controls!.kind).toMatchObject({
    value: "feature",
    by: "default",
    skipped: [],
  });
});

test("ui: the owner sets the kind from the page", async () => {
  const { db, actions } = realActions({});
  expect(await actions.kind!(IDS.upnext, "refactor", "owner")).toContain("refactor");
  expect(
    db.get<{ name: string; arg: string; text: string; source: string }>("SELECT * FROM commands"),
  ).toMatchObject({
    name: "kind",
    arg: IDS.upnext,
    text: "refactor",
    source: "ui",
  });
  await expect(actions.kind!(IDS.upnext, "huge", "owner")).rejects.toThrow("Kind is one of");
});

test("ui: a kind change past the skipped stage is refused", async () => {
  const { db, actions } = realActions({}, "build");
  await expect(actions.kind!(IDS.upnext, "bugfix", "owner")).rejects.toThrow("can no longer skip it");
  expect(db.all("SELECT * FROM commands")).toHaveLength(0);
  // The full path is always open: it sends the mission back to design.
  await actions.kind!(IDS.upnext, "feature", "owner");
  expect(db.all("SELECT * FROM commands")).toHaveLength(1);
  const f = world();
  intent(f, IDS.building).kind = "feature";
  const k = (await plane(f, IDS.building)).controls!.kind;
  expect(k.options.find((o) => o.value === "bugfix")!.refused).toContain("can no longer skip it");
});

test("ui: a viewer cannot set the kind", async () => {
  const f = world();
  expect((await plane(f, IDS.upnext, false)).controls!.kind.canSet).toBe(false);
  const { db, actions } = realActions({});
  await expect(actions.kind!(IDS.upnext, "bugfix", "viewer")).rejects.toThrow("only you can change the kind");
  expect(db.all("SELECT * FROM commands")).toHaveLength(0);
});

test("autonomy: only the owner changes the kind of an a0 intent", async () => {
  const { db, actions } = realActions({ a: 0 });
  await expect(actions.kind!(IDS.upnext, "bugfix", "agent")).rejects.toThrow("only you can change the kind");
  expect(db.all("SELECT * FROM commands")).toHaveLength(0);
});
