// REPO-49: when the repo's own checks replace the overlay's, the owner is told once; nothing switches silently.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ensureClone } from "../../src/checkout.ts";
import { Db } from "../../src/db.ts";
import type { Ctx } from "../../src/handlers.ts";
import type { Mission } from "../../src/mission.ts";
import { repoFiles } from "../../src/pipeline/common.ts";
import { noticeKey, pollRepoSettings } from "../../src/repo/poll.ts";
import type { SettingsEnv } from "../../src/repo/settings.ts";
import { loadRepos } from "../../src/repos.ts";
import { FakeForge } from "../helpers/fake-forge.ts";
import { FakeTools } from "../helpers/tools.ts";
import { bareRepo, git, pushFiles, tempDir, testConfig, testHome } from "../helpers/world.ts";

const T0 = 1_793_000_000;
const CLAUDE = (cmd: string) => `# R\n\n## Verifying your work\n\n\`\`\`checks\n${cmd}\n\`\`\`\n`;
const OVERLAY = "```checks\nnpm test\n```\n";

let saved: string | undefined;
let bare: string;
beforeEach(() => {
  saved = process.env.GIT_CONFIG_GLOBAL;
  bare = bareRepo({ "CLAUDE.md": "# prose\n", "README.md": "web\n" });
  const file = join(tempDir(), "gitconfig");
  writeFileSync(file, `[url "${bare}"]\n\tinsteadOf = https://github.com/owner/web.git\n`);
  process.env.GIT_CONFIG_GLOBAL = file;
});
afterEach(() => {
  if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = saved;
});

function world() {
  const cfg = tempDir("tc-cfg-");
  const configFile = join(cfg, "config.toml");
  mkdirSync(join(cfg, "repos", "web"), { recursive: true });
  const overlay = (text: string) => writeFileSync(join(cfg, "repos", "web", "verifying.md"), text);
  overlay(OVERLAY);
  const db = Db.memory();
  const config = testConfig({ repos: { web: { github: "owner/web" } } }, configFile);
  loadRepos(config, db, T0);
  const tools = new FakeTools();
  const home = testHome();
  const env = (): SettingsEnv => ({
    db,
    tools,
    forge: new FakeForge(),
    home: home.root,
    now: T0,
    repos: config.repos,
    configFile,
  });
  const poll = () => pollRepoSettings(env(), () => undefined);
  const outbox = () =>
    db.all<{ key: string; text: string }>("SELECT key, text FROM outbox WHERE key LIKE 'overlay-checks:%'");
  return { db, config, tools, home, configFile, overlay, poll, outbox };
}

test("repo: repo checks replacing overlay checks send one notice", async () => {
  const w = world();
  await w.poll();
  // The repo has no checks yet: the overlay's apply and nobody is told.
  expect(w.outbox()).toEqual([]);
  expect(w.db.meta(noticeKey("web"))).toBeNull();
  pushFiles(bare, { "CLAUDE.md": CLAUDE("make test") });
  await w.poll();
  const [row] = w.outbox();
  expect(w.outbox()).toHaveLength(1);
  expect(row!.text).toBe(
    `web: the repo now has its own checks (CLAUDE.md on main), so the overlay's checks in ${join(w.configFile, "..", "repos", "web", "verifying.md")} are no longer used.`,
  );
  // The page's card reads the same text.
  expect(JSON.parse(w.db.meta(noticeKey("web"))!).text).toBe(row!.text);
});

test("repo: the same pair does not notify twice", async () => {
  const w = world();
  pushFiles(bare, { "CLAUDE.md": CLAUDE("make test") });
  await w.poll();
  await w.poll();
  expect(w.outbox()).toHaveLength(1);
  // Changing either set of checks is a new pair, so a new notice.
  pushFiles(bare, { "CLAUDE.md": CLAUDE("make check") });
  await w.poll();
  expect(w.outbox()).toHaveLength(2);
  w.overlay("```checks\nnpm run lint\n```\n");
  await w.poll();
  expect(w.outbox()).toHaveLength(3);
  // The repo drops its checks: the card goes, the overlay's apply again, and the old pair stays told.
  pushFiles(bare, { "CLAUDE.md": "# prose\n" });
  await w.poll();
  expect(w.db.meta(noticeKey("web"))).toBeNull();
  expect(w.outbox()).toHaveLength(3);
});

test("repo: a running intent keeps its checks", async () => {
  const w = world();
  await w.poll();
  const clone = join(w.home.root, "repos", "web");
  const cx = {
    tools: w.tools,
    db: w.db,
    config: w.config,
    home: w.home,
    repo: () => ({ ...w.config.repos.get("web")!, path: clone }),
  } as unknown as Ctx;
  const mission = (data: object) => ({ repo: "web", data: JSON.stringify(data) }) as unknown as Mission;
  // Make Towercab's clone current, as the pick does.
  await ensureClone(w.tools, clone, cx.repo(mission({})));
  const first = await repoFiles(cx, mission({}));
  expect(first.verifying.checks).toEqual(["npm test"]);
  const pinned = { pinnedChecks: first.verifying };
  // The repo merges its own checks.
  pushFiles(bare, { "CLAUDE.md": CLAUDE("make test") });
  git(clone, "fetch", "-q", bare, "+refs/heads/main:refs/remotes/origin/main");
  // A new intent gets the repo's; the one that started on the overlay's keeps them.
  expect((await repoFiles(cx, mission({}))).verifying.checks).toEqual(["make test"]);
  expect((await repoFiles(cx, mission(pinned))).verifying.checks).toEqual(["npm test"]);
});
