// LOOP-122, UI-211: how to install the App on a repo it can't reach.

import { join } from "node:path";
import { expect, test } from "vitest";
import { App, AppNotInstalled, HELP_TTL_S, type InstallHelp, SETTINGS_URL } from "../../src/github/app.ts";
import { TestClock, tempDir, testDb } from "../helpers/world.ts";
import { FakeApi, writeKey } from "./fakes.ts";

function setup() {
  const keyPath = join(tempDir(), "app.pem");
  writeKey(keyPath);
  const clock = new TestClock();
  const api = new FakeApi({ "me/a": 11 }, clock);
  const db = testDb();
  const app = new App({ appId: 77, apiBase: api.base, keyPath, db, http: api.http, clock });
  return { clock, api, db, app };
}

async function helpOf(app: App, repo: string): Promise<InstallHelp> {
  const e = await app.token(repo).then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(AppNotInstalled);
  return (e as AppNotInstalled).help;
}

const appCalls = (api: FakeApi) => api.calls().filter((c) => c === "GET /app").length;

test("app: a missing install says how to install the App", async () => {
  const { api, app } = setup();
  const e = await app.token("me/c").catch((x: unknown) => x);
  expect((e as Error).message).toBe("the GitHub App isn't installed on me/c");
  const help = (e as AppNotInstalled).help;
  expect(help.app).toBe("Towercab Bot");
  expect(help.url).toBe("https://github.com/apps/towercab/installations/new");
  expect(help.steps[0]).toBe(`Open ${help.url} to install “Towercab Bot”.`);
  expect(help.steps).toContain("Choose me and pick c.");
  expect(help.steps.at(-1)).toContain("Try again");
  // The 404 is not kept: once the App is installed the next try goes through.
  api.reinstall("me/c", 31);
  await expect(app.token("me/c")).resolves.toMatch(/^tok-31-/);
});

test("app: a selected-repos install links to its settings", async () => {
  const { api, app } = setup();
  api.accounts.set("me", { id: 9, repository_selection: "selected", account: { type: "User" } });
  const user = await helpOf(app, "me/c");
  expect(user.url).toBe("https://github.com/settings/installations/9");
  expect(user.steps).toContain("Under Repository access, add c.");
  api.accounts.set("acme", { id: 12, repository_selection: "selected", account: { type: "Organization" } });
  const org = await helpOf(app, "acme/web");
  expect(org.url).toBe("https://github.com/organizations/acme/settings/installations/12");
});

test("app: help falls back to the stored install URL", async () => {
  const { clock, api, db, app } = setup();
  await helpOf(app, "me/c");
  expect(db.meta("app-install-url")).toBe("https://github.com/apps/towercab/installations/new");
  api.appDown = true;
  api.lookupDown = true;
  clock.advance(HELP_TTL_S + 1);
  const help = await helpOf(app, "me/d");
  expect(help.url).toBe("https://github.com/apps/towercab/installations/new");
  expect(help.app).toBe("Towercab Bot");
});

test("app: help falls back to the general settings link when nothing was stored", async () => {
  const { api, db, app } = setup();
  api.appDown = true;
  api.lookupDown = true;
  const help = await helpOf(app, "me/c");
  expect(help.url).toBe(SETTINGS_URL);
  expect(help.app).toBeNull();
  expect(help.steps[0]).toContain(SETTINGS_URL);
  expect(db.meta("app-install-url")).toBeNull();
});

test("app: install help holds no token", async () => {
  const { api, app } = setup();
  api.accounts.set("me", { id: 9, repository_selection: "selected", account: { type: "User" } });
  await app.token("me/a");
  const text = JSON.stringify(await helpOf(app, "me/c"));
  expect(text).not.toMatch(/tok-|BEGIN|eyJ|Bearer/);
  for (const t of api.tokens) expect(text).not.toContain(t[1]);
});

test("state: install help is cached for 10 minutes per repo", async () => {
  const { clock, api, app } = setup();
  await helpOf(app, "me/c");
  await helpOf(app, "ME/C");
  expect(appCalls(api)).toBe(1);
  // The sync peek hands out the kept help without asking again.
  expect(app.peekInstallHelp("me/c").url).toContain("/installations/new");
  expect(appCalls(api)).toBe(1);
  clock.advance(HELP_TTL_S + 1);
  await helpOf(app, "me/c");
  expect(appCalls(api)).toBe(2);
});

test("state: install help is refreshed when the repo becomes reachable", async () => {
  const { api, app } = setup();
  await helpOf(app, "me/c");
  api.reinstall("me/c", 31);
  await app.token("me/c");
  // Kept help is dropped: asking again looks it up anew.
  await app.installHelp("me/c");
  expect(appCalls(api)).toBe(2);
});
