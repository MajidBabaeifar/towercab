// UI-140 to UI-145: the Repos tab: chips, a repo's page (feature list, work, spend), the All view, and
// asking for a repo's feature list from the repo.

import { afterEach, expect, test } from "vitest";
import { Db } from "../../src/db.ts";
import { askFeatures, featuresRun } from "../../src/features.ts";
import { createActions } from "../../src/ui/actions.ts";
import { repos } from "../../src/ui/repos.ts";
import { startUi } from "../../src/ui/server.ts";
import { buildFixture, type Fixture, IDS, MemStore } from "../../ui/fixture.ts";
import { TestClock, tempDir, testConfig } from "../helpers/world.ts";
import { call, post } from "./http.ts";

// Mon 26 Oct 2026, 23:00:00 local time.
const NOW = new Date(2026, 9, 26, 23, 0, 0).getTime() / 1000;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});
function fixture(): Fixture {
  const f = buildFixture({ now: NOW });
  cleanup.push(() => f.cleanup());
  return f;
}

test("ui: repos chips and the All view", async () => {
  const f = fixture();
  const page = await repos(f.sources, null);
  expect(page.selected).toBeNull();
  expect(page.repo).toBeNull();
  expect(page.chips.map((c) => [c.repo, c.open, c.needs])).toEqual([
    ["web", 5, 1],
    ["api", 1, 1],
    ["docs", 3, 1],
    ["mobile", 1, 0],
    ["infra", 2, 0],
    ["blog", 1, 0],
  ]);
  const web = page.all.find((s) => s.repo === "web")!;
  expect(web).toMatchObject({ inProgress: 2, needs: 1, upNext: 1, waiting: 1, parked: 1 });
  expect(web.spend.all).toMatch(/^\$\d+\.\d\d$/);
  expect(page.error).toBeNull();
  // An unknown repo: All, and why.
  const missing = await repos(f.sources, "nope");
  expect(missing.selected).toBeNull();
  expect(missing.error).toBe("There is no repo named “nope”. These are all of them.");
});

test("ui: a repo page shows its features, work and spend", async () => {
  const f = fixture();
  const page = await repos(f.sources, "web");
  expect(page.selected).toBe("web");
  expect(page.all).toEqual([]);
  const r = page.repo!;
  expect(r.inProgress.map((x) => x.intent)).toEqual([IDS.question, IDS.ci]);
  expect(r.upNext.map((x) => [x.position, x.title])).toEqual([[1, "Dark mode for the settings page"]]);
  expect(r.waiting.map((x) => [x.title, x.reason])).toEqual([
    ["Gift cards at checkout", "Waits for “Faster checkout page” to be done."],
  ]);
  expect(r.parked.map((x) => x.title)).toEqual(["Try a new chart library"]);
  const fv = r.features;
  expect(fv.inProgress.map((x) => [x.text, x.intent])).toEqual([
    ["People can export their invoices as a CSV file.", IDS.question],
    ["Shoppers get through checkout in fewer steps.", IDS.ci],
  ]);
  expect(fv.live).toHaveLength(6);
  expect(fv.live.at(-1)).toEqual({ text: "People can sign in with GitHub.", intent: IDS.done1 });
  // The file's planned line, then the queued intents without a line (INT-40); never parked ones.
  expect(fv.planned.map((x) => [x.text, x.intent])).toEqual([
    ["Shoppers can save a basket and finish it on another device.", null],
    ["Dark mode for the settings page", IDS.queued],
    ["Gift cards at checkout", IDS.held],
  ]);
  expect(fv.url).toBe("https://github.com/acme/intents/blob/main/features/web.md");
  expect(fv.run).toBe("done");
  expect(fv.note).toBe("Last read from the repo on Fri 23:00: 5 live features.");
  expect(fv.canRefresh).toBe(true);
  expect(r.spend.today).toMatch(/^\$\d+\.\d\d$/);
});

test("ui: the first look asks for the backfill once", async () => {
  const f = fixture();
  const asked: string[] = [];
  const ask = async (repo: string) => {
    asked.push(repo);
    askFeatures(f.db, repo, NOW);
  };
  // web already has a list of its own: no ask.
  expect((await repos(f.sources, "web", { ask })).repo!.features.run).toBe("done");
  const api = (await repos(f.sources, "api", { ask })).repo!.features;
  expect(asked).toEqual(["api"]);
  expect(api.run).toBe("due");
  expect(api.canRefresh).toBe(false);
  expect(api.note).toMatch(/^Towercab will read the repo's README and specs/);
  // Asked: the next look doesn't ask again; the All view never asks.
  await repos(f.sources, "api", { ask });
  await repos(f.sources, null, { ask });
  expect(asked).toEqual(["api"]);
  // Without a running loop nothing is asked, and nothing offered.
  const docs = (await repos(f.sources, "docs")).repo!.features;
  expect(docs.run).toBe("never");
  expect(docs.note).toBe("Towercab writes this list from the repo's README and specs once it runs.");
});

test("ui: features action asks the loop once", async () => {
  const db = Db.memory();
  const clock = new TestClock();
  const a = createActions({
    db,
    store: new MemStore(),
    config: testConfig(),
    clock,
    github: { owner: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }) },
  });
  const repo = [...testConfig().repos.keys()][0]!;
  expect(await a.features(repo)).toMatch(/^Towercab reads the repo's README and specs/);
  expect(featuresRun(db, repo)).toMatchObject({ state: "due" });
  expect(await a.features(repo)).toBe("Towercab is already reading the repo for its feature list.");
  await expect(a.features("nope")).rejects.toThrow("Towercab doesn't know a repo named nope.");
});

test("ui: repos API and refresh go through the server", async () => {
  const f = fixture();
  const ui = startUi({ port: 0, sources: f.sources, actions: f.actions, distDir: tempDir(), log: () => {} });
  cleanup.push(() => ui.stop());
  const port = await ui.ready;
  const page = JSON.parse((await call(port, { path: "/api/repos?repo=web" })).body);
  expect(page.selected).toBe("web");
  // The first look at a repo without a list asks for it, through the actions.
  await call(port, { path: "/api/repos?repo=api" });
  expect(f.calls).toContainEqual({ action: "features", repo: "api" });
  const r = await post(port, ui.token, { action: "features", repo: "web" });
  expect(r.status).toBe(200);
  expect(f.calls.at(-1)).toEqual({ action: "features", repo: "web" });
  expect((await post(port, ui.token, { action: "features", repo: "../x" })).status).toBe(400);
  // `/repos` and the old `/queue` serve the page.
  expect((await call(port, { path: "/repos" })).status).toBe(200);
  expect((await call(port, { path: "/queue" })).status).toBe(200);
});
