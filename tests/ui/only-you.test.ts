// UI-239: owner-only (a0) intents say "only you" and can be paused and resumed from the page.

import { afterEach, expect, test } from "vitest";
import { noteIgnored } from "../../src/commands.ts";
import { createActions } from "../../src/ui/actions.ts";
import { intentPage, overview } from "../../src/ui/state.ts";
import { buildFixture, type Fixture, IDS } from "../../ui/fixture.ts";

const NOW = new Date(2026, 9, 26, 23, 0, 0).getTime() / 1000;
const open: Fixture[] = [];
afterEach(() => {
  while (open.length) open.pop()!.cleanup();
});

function world() {
  const f = buildFixture({ now: NOW });
  open.push(f);
  const clock = { now: () => NOW, mono: () => 0 };
  const actions = createActions({
    db: f.db,
    store: f.store,
    config: f.sources.config,
    clock,
    github: { owner: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }) },
  });
  const commands = () =>
    f.db.all<{ name: string; arg: string; source: string }>(
      "SELECT name, arg, source FROM commands ORDER BY id",
    );
  return { f, actions, clock, commands };
}

test("ui: a0 intents show only you", async () => {
  const w = world();
  const needs = async () => (await overview({ ...w.f.sources, clock: w.clock })).needs;
  expect((await needs()).find((c) => c.intent === IDS.question)!.onlyYou).toBeUndefined();
  expect((await intentPage(w.f.sources, IDS.question))!.onlyYou).toBeUndefined();

  w.f.store.open.find((i) => i.id === IDS.question)!.a = 0;
  expect((await needs()).find((c) => c.intent === IDS.question)!.onlyYou).toBe(true);
  expect((await needs()).find((c) => c.intent === IDS.plan)!.onlyYou).toBeUndefined();

  const page = (await intentPage(w.f.sources, IDS.question))!;
  expect(page.onlyYou).toBe("Only you can answer or approve this.");
  // A reply that was ignored shows on the timeline.
  noteIgnored(
    w.f.db,
    IDS.question,
    "code:comment:c1",
    "ignored a comment from mallory on the code PR #7",
    NOW,
  );
  const again = (await intentPage(w.f.sources, IDS.question))!;
  expect(again.timeline.map((t) => t.text)).toContain("ignored a comment from mallory on the code PR #7");
  // Other intents' pages do not carry the label or the note.
  const other = (await intentPage(w.f.sources, IDS.plan))!;
  expect(other.onlyYou).toBeUndefined();
});

test("ui: an intent can be paused and resumed from the page", async () => {
  const w = world();
  expect(await w.actions.pause(IDS.question)).toMatch("no further stage of this intent");
  expect(await w.actions.resume(IDS.question)).toMatch("goes on with this intent");
  // No intent: the global pause and resume, as before.
  await w.actions.pause();
  await w.actions.resume();
  expect(w.commands()).toEqual([
    { name: "pause", arg: IDS.question, source: "ui" },
    { name: "resume", arg: IDS.question, source: "ui" },
    { name: "pause", arg: "", source: "ui" },
    { name: "resume", arg: "", source: "ui" },
  ]);
  // An actor other than the owner can't act on an a0 intent from the page's API, but may pause it.
  w.f.store.open.find((i) => i.id === IDS.question)!.a = 0;
  await expect(w.actions.guard!(IDS.question, "reply", "shadow")).rejects.toThrow(
    `${IDS.question} is only yours: use GitHub or the page`,
  );
  await expect(w.actions.guard!(IDS.question, "pause", "shadow")).resolves.toBeUndefined();
  await expect(w.actions.guard!(IDS.question, "reply", "owner")).resolves.toBeUndefined();
  await expect(w.actions.guard!(IDS.plan, "reply", "shadow")).resolves.toBeUndefined();
});
