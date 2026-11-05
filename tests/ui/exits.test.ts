// UI-164: every way out of a wait is a button that does what it says.

import { afterEach, expect, test } from "vitest";
import { createActions } from "../../src/ui/actions.ts";
import { overview } from "../../src/ui/state.ts";
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
  const calls: string[][] = [];
  const actions = createActions({
    db: f.db,
    store: f.store,
    config: f.sources.config,
    clock,
    github: {
      owner: async (args) => {
        calls.push(args);
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
    },
  });
  const patch = (id: string, cols: string, ...args: unknown[]) =>
    f.db.run(`UPDATE missions SET ${cols} WHERE intent = ?`, ...(args as never[]), id);
  const card = async (id: string) =>
    (await overview({ ...f.sources, clock })).needs.find((c) => c.intent === id)!;
  const commands = () =>
    f.db.all<{ name: string; arg: string; text: string }>("SELECT name, arg, text FROM commands ORDER BY id");
  return { f, actions, calls, patch, card, commands };
}

test("ui: question options are buttons that do what they say", async () => {
  const w = world();
  const options = (await w.card(IDS.question)).question!.options;
  const d = JSON.parse(
    w.f.db.get<{ data: string }>("SELECT data FROM missions WHERE intent = ?", IDS.question)!.data,
  );
  d.question.options = [
    { ...options[0], do: "continue" },
    { ...options[1], do: "steps" },
    { ...options[2], do: "drop" },
  ];
  w.patch(IDS.question, "data = ?", JSON.stringify(d));
  const card = await w.card(IDS.question);
  // The page gets each option's action and renders it as a button.
  expect(card.question!.options.map((o) => o.do)).toEqual(["continue", "steps", "drop"]);
  expect(card.exits.map((e) => e.do)).toEqual(["continue", "steps", "retry", "drop"]);
  // Each button calls the action it says: continue replies with the option, steps switches, drop drops.
  await w.actions.reply(IDS.question, options[0]!.option);
  await w.actions.steps!(IDS.question);
  expect(w.commands().map((c) => c.name)).toContain("steps");
  const after = await w.card(IDS.question);
  expect(after.done).toMatchObject({
    action: "steps",
    text: "Switched to steps by you · Towercab moves on within a minute",
  });
  expect(after.actions).toEqual([]);
});

test("ui: no changes offers I did it myself", async () => {
  const w = world();
  w.patch(IDS.question, "waiting = ?, why = ?, data = ?", "no changes", "nothing changed", "{}");
  const card = await w.card(IDS.question);
  expect(card.ask).toMatch(/say you did it yourself/);
  expect(card.exits.map((e) => e.label)).toContain("Nothing to build: I did it myself");
  expect(card.actions).toEqual(["reply", "retry", "drop"]);
  const msg = await w.actions.done!(IDS.question, "  turned the setting on  ");
  expect(msg).toMatch(/Marked as done by you/);
  expect(w.commands()).toEqual([{ name: "done", arg: IDS.question, text: "turned the setting on" }]);
  // A reload shows the same card with no buttons, until the loop moves the mission on.
  const again = await w.card(IDS.question);
  expect(again.done).toMatchObject({
    action: "done",
    text: "Marked done by you · Towercab moves on within a minute",
  });
  expect(again.actions).toEqual([]);
  expect(again.exits).toEqual([]);
});

test("ui: a stuck wait offers only the other exits", async () => {
  const w = world();
  w.patch(IDS.question, "waiting = ?, data = ?", "no changes", JSON.stringify({ stuck: true }));
  const card = await w.card(IDS.question);
  expect(card.stuck).toBe(true);
  expect(card.actions).toEqual(["retry", "drop"]);
  expect(card.exits.map((e) => e.do)).toEqual(["done", "steps", "retry", "drop"]);
});

test("ui: exits come from the API", async () => {
  const w = world();
  const o = await overview({ ...w.f.sources, clock: { now: () => NOW, mono: () => 0 } });
  const json = JSON.parse(JSON.stringify(o)) as {
    needs: { intent: string; exits: { do: string; label: string }[]; stuck: boolean }[];
  };
  expect(json.needs.length).toBeGreaterThan(0);
  for (const c of json.needs) {
    expect(c.exits.length, c.intent).toBeGreaterThan(0);
    expect(c.stuck, c.intent).toBe(false);
  }
  const plan = json.needs.find((c) => c.intent === IDS.plan)!;
  expect(plan.exits.map((e) => e.do)).toEqual(["merge", "retry", "drop"]);
});
