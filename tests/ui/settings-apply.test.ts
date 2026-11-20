// REPO-38, REPO-39: the repo card's plan and Apply, and the action that runs it.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Db } from "../../src/db.ts";
import { saveSettings } from "../../src/settings/store.ts";
import type { UiActions } from "../../src/ui/actions.ts";
import { settingsView } from "../../src/ui/repos.ts";
import { startUi } from "../../src/ui/server.ts";
import { buildFixture } from "../../ui/fixture.ts";
import { tempDir } from "../helpers/world.ts";
import { post } from "./http.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

test("ui: a repo with gaps shows the plan and Apply", () => {
  const db = Db.memory();
  saveSettings(db, "web", {
    state: "gaps",
    gaps: ["merge rules are off"],
    tag: "v1.0.0",
    at: 5,
    plan: [{ what: "delete_branch_on_merge", now: "false", after: "true" }],
  });
  expect(settingsView(db, "web", true)).toMatchObject({
    state: "gaps",
    plan: [{ what: "delete_branch_on_merge", now: "false", after: "true" }],
    planNote: null,
    canApply: true,
  });
  // A page that can't act offers no button; a release without a plan says so and still offers Apply.
  expect(settingsView(db, "web", false).canApply).toBe(false);
  saveSettings(db, "api", { state: "gaps", gaps: ["x"], tag: "v1.0.0", at: 5 });
  expect(settingsView(db, "api", true)).toMatchObject({
    plan: [],
    planNote: "The plan is not available from this ci release",
    canApply: true,
  });
});

test("ui: a repo with settings in place shows no Apply", () => {
  const db = Db.memory();
  saveSettings(db, "web", { state: "ok", gaps: [], tag: "v1.0.0", at: 5 });
  saveSettings(db, "api", { state: "unknown", gaps: [], tag: null, at: 5, note: "no ci release" });
  expect(settingsView(db, "web", true)).toMatchObject({ state: "ok", canApply: false, plan: [] });
  expect(settingsView(db, "api", true).canApply).toBe(false);
  expect(settingsView(db, "none", true).canApply).toBe(false);
});

test("ui: Apply posts the action and shows the new check", async () => {
  const f = buildFixture();
  const seen: string[] = [];
  const actions: UiActions = {
    ...f.actions,
    applySettings: async (repo) => {
      seen.push(repo);
      return "Applied. The standard settings are in place on owner/web.";
    },
  };
  const d = tempDir("tc-dist-");
  mkdirSync(join(d, "assets"));
  writeFileSync(join(d, "index.html"), '<html><head><meta name="towercab-token" content="" /></head></html>');
  const ui = startUi({ port: 0, sources: f.sources, actions, distDir: d, log: () => {}, pollMs: 20 });
  cleanup.push(() => f.cleanup());
  cleanup.push(() => ui.stop());
  const port = await ui.ready;
  const ok = await post(port, ui.token, { action: "apply-settings", repo: "web" });
  expect(ok.status).toBe(200);
  expect(JSON.parse(ok.body)).toMatchObject({ ok: true, message: expect.stringContaining("Applied") });
  expect(seen).toEqual(["web"]);
  // A repo is required, and nothing runs without it.
  expect((await post(port, ui.token, { action: "apply-settings" })).status).toBe(400);
  expect((await post(port, ui.token, { action: "apply-settings", repo: "../x" })).status).toBe(400);
  expect(seen).toEqual(["web"]);
});
