// REPO-47: `towercab doctor` shows where each setting of a repo with an overlay comes from.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ensureClone } from "../src/checkout.ts";
import { clonePath } from "../src/config.ts";
import { doctor } from "../src/doctor.ts";
import { FakeTools } from "./helpers/tools.ts";
import { bareRepo, tempDir, testConfig, testHome } from "./helpers/world.ts";

const CLAUDE = "# R\n\n## Verifying your work\n\n```checks\nmake test\n```\n";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.GIT_CONFIG_GLOBAL;
});
afterEach(() => {
  if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = saved;
});

/** A repo `web` cloned from a local origin with `files`, and a config whose folder may hold an overlay. */
async function world(files: Record<string, string>, overlay: Record<string, string> = {}) {
  const bare = bareRepo(files);
  const gitconfig = join(tempDir(), "gitconfig");
  writeFileSync(gitconfig, `[url "${bare}"]\n\tinsteadOf = https://github.com/owner/web.git\n`);
  process.env.GIT_CONFIG_GLOBAL = gitconfig;
  const cfg = tempDir("tc-cfg-");
  const file = join(cfg, "config.toml");
  const dir = join(cfg, "repos", "web");
  if (Object.keys(overlay).length) mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(overlay)) writeFileSync(join(dir, name), text);
  const config = testConfig({ repos: { web: { github: "owner/web" } } }, file);
  const home = testHome();
  const tools = new FakeTools();
  const repo = config.repos.get("web")!;
  await ensureClone(tools, clonePath(repo, home.root), repo, undefined);
  const run = () => doctor({ config, home, tools, github: null, quick: false });
  return { run, dir };
}

test("doctor: settings show their source", async () => {
  const w = await world(
    { "CLAUDE.md": CLAUDE, "TOWERCAB.md": "---\nmax_autonomy: 4\ntests: [t/**]\n---\n" },
    { "TOWERCAB.md": "---\nmax_autonomy: 2\nprotected: [infra/**]\ntests: [x/**]\n---\n" },
  );
  const r = await w.run();
  expect(r.lines).toContain("web: max_autonomy = 2 (overlay)");
  expect(r.lines).toContain("web: protected = infra/** (overlay)");
  expect(r.lines).toContain("web: tests = t/** (repo)");
  expect(r.lines).toContain("web: workers = 1 (default)");
  expect(r.lines).toContain("web: checks = make test (repo)");
  expect(r.lines).toContain("web: overlay tests refused: looser than the repo's value");
});

test("doctor: an invalid overlay fails", async () => {
  const w = await world({ "CLAUDE.md": CLAUDE }, { "TOWERCAB.md": "---\nmax_autonomy: 9\n---\n" });
  const r = await w.run();
  expect(r.lines).toContain("web: overlay TOWERCAB.md: front matter: max_autonomy must be an integer 1-5");
  expect(r.ok).toBe(false);
});

test("doctor: no overlay prints no source lines", async () => {
  const w = await world({ "CLAUDE.md": CLAUDE });
  const r = await w.run();
  expect(r.lines.filter((l) => /^web: (max_autonomy|checks|protected) =/.test(l))).toEqual([]);
});
