// REPO-48: a settings change Towercab makes never writes the overlay into the repo.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Db } from "../../src/db.ts";
import { pollRepoSettings } from "../../src/repo/poll.ts";
import { moveRepo, PARSER_KEY, proposeSettings, type SettingsEnv } from "../../src/repo/settings.ts";
import { loadRepos, readRepos } from "../../src/repos.ts";
import { FakeForge } from "../helpers/fake-forge.ts";
import { FakeTools } from "../helpers/tools.ts";
import { bareRepo, git, tempDir, testConfig, testHome } from "../helpers/world.ts";

const T0 = 1_793_000_000;
const HOUR = 3600;

let saved: string | undefined;
let bare: string;
beforeEach(() => {
  saved = process.env.GIT_CONFIG_GLOBAL;
  bare = bareRepo({ "CLAUDE.md": "x\n", "README.md": "web\n" });
  const file = join(tempDir(), "gitconfig");
  writeFileSync(file, `[url "${bare}"]\n\tinsteadOf = https://github.com/owner/web.git\n`);
  process.env.GIT_CONFIG_GLOBAL = file;
});
afterEach(() => {
  if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = saved;
});

/** A loop's settings world with an overlay folder holding `overlay` as repo `web`'s `TOWERCAB.md`. */
function world(overlay: string) {
  const cfg = tempDir("tc-cfg-");
  const configFile = join(cfg, "config.toml");
  mkdirSync(join(cfg, "repos", "web"), { recursive: true });
  writeFileSync(join(cfg, "repos", "web", "TOWERCAB.md"), overlay);
  const db = Db.memory();
  const config = testConfig({ repos: { web: { github: "owner/web" } } }, configFile);
  loadRepos(config, db, T0);
  const forge = new FakeForge();
  const home = testHome();
  const env = (): SettingsEnv => ({
    db,
    tools: new FakeTools(),
    forge,
    home: home.root,
    now: T0,
    repos: config.repos,
    configFile,
  });
  db.setMeta(PARSER_KEY, `abc ${T0 - 25 * HOUR}`);
  return { db, forge, env, poll: () => pollRepoSettings(env(), () => undefined) };
}

test("repo: a settings PR never copies overlay values", async () => {
  const w = world("---\nahead: 1\n---\n");
  await w.poll();
  // The overlay's stricter value applies as the repo's limit…
  expect(readRepos(w.db)[0]!.ahead).toBe(1);
  // …but a save writes only what the owner changed.
  await proposeSettings(w.env(), "web", { workers: 2 });
  const file = git(bare, "show", "towercab/settings-web-1:TOWERCAB.md");
  expect(file).toContain("workers: 2");
  expect(file).not.toContain("ahead");
});

test("repo: an overlay key is not saved through a PR", async () => {
  const w = world("---\nahead: 1\n---\n");
  await w.poll();
  // The one-time move writes database values the repo's file lacks; the overlay's `ahead` is not one.
  expect(await moveRepo(w.env(), "web")).toBeNull();
  expect(w.forge.prs).toHaveLength(0);
  expect(readRepos(w.db)[0]!.ahead).toBe(1);
});

test("repo: an overlay limit above the default is not applied", async () => {
  const w = world("---\nahead: 9\nworkers: 4\n---\n");
  await w.poll();
  expect(readRepos(w.db)[0]).toMatchObject({ ahead: 3, workers: 1 });
});
