// SHIP-34, SHIP-35 on the page: a secret step carries its pull request and approval but never a value,
// and the page's two actions reach the code that writes and approves.

import { afterEach, expect, test } from "vitest";
import { createActions } from "../../src/ui/actions.ts";
import { startUi } from "../../src/ui/server.ts";
import { intentPage } from "../../src/ui/state.ts";
import { buildFixture, type Fixture, IDS } from "../../ui/fixture.ts";
import { TestClock, testConfig } from "../helpers/world.ts";
import { post } from "./http.ts";

const NOW = new Date(2026, 9, 26, 23, 0, 0).getTime() / 1000;
const open: (() => unknown)[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
});

const SECRET = {
  repo: "web",
  file: "secrets/apps/herald.yaml",
  key: "PLATFORM_TOKEN",
  purpose: "posts to the platform",
  source: "supply",
};

function fixture(secrets: object | null): Fixture {
  const f = buildFixture({ now: NOW });
  open.push(() => f.cleanup());
  const data = {
    steps: [
      {
        n: 1,
        when: "after",
        text: "Add the token",
        why: "posts to the platform",
        done_at: null,
        secret: SECRET,
      },
    ],
    ...(secrets ? { secrets } : {}),
  };
  f.db.run(
    "UPDATE missions SET stage = 'steps', step = '', waiting = 'your steps', data = ? WHERE id = (SELECT MAX(id) FROM missions WHERE intent = ?)",
    JSON.stringify(data),
    IDS.code,
  );
  return f;
}

test("ui: a secret step shows its pull request and approval, never a value", async () => {
  const f = fixture({ "1": { pr: 7, approved: false, fails: 3, error: "sops: no age key" } });
  const step = (await intentPage(f.sources, IDS.code))!.steps![0]!;
  expect(step.secret).toMatchObject({
    key: "PLATFORM_TOKEN",
    source: "supply",
    approved: false,
    error: "sops: no age key",
    stopped: true,
  });
  expect(step.secret!.pr!.number).toBe(7);
  expect(JSON.stringify(step)).not.toMatch(/value/i);
});

test("ui: the secret and approve actions reach their code, and the reply never echoes the value", async () => {
  const f = fixture({ "1": { pr: 7, approved: false } });
  const sent: [string, number, string][] = [];
  const actions = createActions({
    db: f.db,
    store: f.store,
    config: testConfig(),
    clock: new TestClock(NOW),
    github: { owner: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }) },
    supplySecret: async (intent, n, value) => {
      sent.push([intent, n, value]);
      return "Saved PLATFORM_TOKEN in a pull request. Approve it to merge.";
    },
  });
  const ui = startUi({
    port: 0,
    sources: f.sources,
    actions,
    distDir: "/nonexistent",
    log: () => {},
    pollMs: 20,
  });
  open.push(() => ui.stop());
  const port = await ui.ready;
  const r = await post(port, ui.token, {
    action: "secret",
    intent: IDS.code,
    n: 1,
    value: "tok_live_9f8e7d",
  });
  expect(r.status).toBe(200);
  expect(r.body).not.toContain("tok_live_9f8e7d");
  expect(sent).toEqual([[IDS.code, 1, "tok_live_9f8e7d"]]);
  const a = await post(port, ui.token, { action: "approve-secret", intent: IDS.code, n: 1 });
  expect(JSON.parse(a.body).ok).toBe(true);
  const page = (await intentPage(f.sources, IDS.code))!;
  expect(page.steps![0]!.secret!.approved).toBe(true);
  // Without the writer the page can't take a secret.
  const bare = createActions({
    db: f.db,
    store: f.store,
    config: testConfig(),
    clock: new TestClock(NOW),
    github: { owner: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }) },
  });
  await expect(bare.secret!(IDS.code, 1, "x")).rejects.toThrow("Secrets aren't available.");
});
