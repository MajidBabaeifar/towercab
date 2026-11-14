// LOOP-76, UI-164: an exit that would close an open code PR with commits asks first; the card carries the PR.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ExitNeedsConfirm } from "../../src/exit-warning.ts";
import { createActions } from "../../src/ui/actions.ts";
import { startUi } from "../../src/ui/server.ts";
import { overview } from "../../src/ui/state.ts";
import { buildFixture, type Fixture, IDS } from "../../ui/fixture.ts";
import { tempDir } from "../helpers/world.ts";
import { post } from "./http.ts";

const NOW = new Date(2026, 9, 26, 23, 0, 0).getTime() / 1000;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

/** `gh pr view` says the PR is open with `commits` commits, or fails with `down`. */
function world(o: { commits?: number; down?: boolean } = {}) {
  const f: Fixture = buildFixture({ now: NOW });
  cleanup.push(() => f.cleanup());
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
        if (args[0] === "pr" && args[1] === "view") {
          if (o.down) return { code: 1, stdout: "", stderr: "HTTP 502", timedOut: false };
          const commits = Array.from({ length: o.commits ?? 3 }, () => ({}));
          return { code: 0, stdout: JSON.stringify({ state: "OPEN", commits }), stderr: "", timedOut: false };
        }
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
    },
  });
  // The question's intent came back to `no changes` after a repair round: its code PR 12 is open.
  f.db.run(
    "UPDATE missions SET stage = 'blocked', from_stage = 'build', waiting = 'no changes', pr = 12, data = '{}' WHERE intent = ?",
    IDS.question,
  );
  const commands = () =>
    f.db.all<{ name: string }>("SELECT name FROM commands ORDER BY id").map((c) => c.name);
  return { f, actions, commands, clock, calls };
}

test("ui: closing an open PR with commits asks to confirm first", async () => {
  const w = world({ commits: 3 });
  for (const [name, run] of [
    ["done", (c?: boolean) => w.actions.done!(IDS.question, "did it", c)],
    ["steps", (c?: boolean) => w.actions.steps!(IDS.question, c)],
    ["drop", (c?: boolean) => w.actions.drop(IDS.question, c)],
  ] as const) {
    const err = await run().catch((e: unknown) => e);
    expect(err, name).toBeInstanceOf(ExitNeedsConfirm);
    expect((err as Error).message).toBe(
      "This closes PR #12 (3 commits) and deletes its branch. Nothing is merged.",
    );
    // Nothing was queued and nothing was closed before the owner said yes.
    expect(w.commands(), name).toEqual([]);
    expect(w.calls.some((a) => a[1] === "close")).toBe(false);
  }
  // Only the confirmed call acts.
  await w.actions.done!(IDS.question, "did it", true);
  expect(w.commands()).toEqual(["done"]);
  // A wait with no open PR needs no confirm.
  const bare = world();
  bare.f.db.run("UPDATE missions SET pr = NULL WHERE intent = ?", IDS.question);
  await bare.actions.steps!(IDS.question);
  expect(bare.commands()).toEqual(["steps"]);
});

test("ui: the API answers 409 with the warning and acts once it is confirmed", async () => {
  const w = world({ commits: 2 });
  const dist = tempDir("tc-dist-");
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "index.html"), '<!doctype html><meta name="towercab-token" content="">');
  const ui = startUi({
    port: 0,
    sources: w.f.sources,
    actions: w.actions,
    distDir: dist,
    log: () => {},
    pollMs: 20,
  });
  cleanup.push(() => ui.stop());
  const port = await ui.ready;
  const asked = await post(port, ui.token, { action: "done", intent: IDS.question, text: "x" });
  expect(asked.status).toBe(409);
  expect(JSON.parse(asked.body)).toMatchObject({
    ok: false,
    confirm: {
      pr: 12,
      commits: 2,
      text: "This closes PR #12 (2 commits) and deletes its branch. Nothing is merged.",
    },
  });
  expect(w.commands()).toEqual([]);
  const sure = await post(port, ui.token, {
    action: "done",
    intent: IDS.question,
    text: "x",
    confirmed: true,
  });
  expect(sure.status).toBe(200);
  expect(w.commands()).toEqual(["done"]);
});

test("ui: an unreadable PR gets the general warning and a confirm", async () => {
  const w = world({ down: true });
  const err = await w.actions.done!(IDS.question, "", false).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ExitNeedsConfirm);
  expect((err as ExitNeedsConfirm).warning).toEqual({
    pr: 12,
    commits: null,
    text: "Couldn't check the PR; it may have commits. It will be closed and its branch deleted.",
  });
  // The outage does not block the exit: confirmed, it goes through.
  await w.actions.done!(IDS.question, "", true);
  expect(w.commands()).toEqual(["done"]);
});

test("ui: the card carries the open PR its exits would close", async () => {
  const w = world();
  w.f.db.run(
    "UPDATE missions SET data = ? WHERE intent = ?",
    JSON.stringify({ openPr: { number: 12, commits: 3 } }),
    IDS.question,
  );
  const card = (await overview({ ...w.f.sources, clock: w.clock })).needs.find(
    (c) => c.intent === IDS.question,
  )!;
  expect(card.openPr).toEqual({
    number: 12,
    commits: 3,
    text: "This closes PR #12 (3 commits) and deletes its branch. Nothing is merged.",
  });
  // Unreadable: the general warning, with no count.
  w.f.db.run(
    "UPDATE missions SET data = ? WHERE intent = ?",
    JSON.stringify({ openPr: { number: 12, commits: null } }),
    IDS.question,
  );
  const again = (await overview({ ...w.f.sources, clock: w.clock })).needs.find(
    (c) => c.intent === IDS.question,
  )!;
  expect(again.openPr).toMatchObject({
    commits: null,
    text: expect.stringContaining("Couldn't check the PR"),
  });
});
