import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { cacheEnv, createCheckout, ensureCheckout, git, gitSane, refreshBase } from "../src/checkout.ts";
import { clonePath } from "../src/config.ts";
import { realTools } from "../src/tools.ts";
import { bareRepo, pushFiles, tempDir, testConfig, git as tgit } from "./helpers/world.ts";

const tools = realTools();

async function cloneOf(bare: string): Promise<string> {
  const clone = join(tempDir(), "clone");
  tgit(tempDir(), "clone", "-q", bare, clone);
  return clone;
}

test("checkout: kept across steps", async () => {
  const bare = bareRepo({ "README.md": "hi\n" });
  const clone = await cloneOf(bare);
  const co = join(tempDir(), "work", "261026-1000-1");
  expect(await ensureCheckout(tools, clone, co, "main", "towercab/261026-1000-x")).toBe(true);
  writeFileSync(join(co, "new.txt"), "work in progress\n");
  expect(await ensureCheckout(tools, clone, co, "main", "towercab/261026-1000-x")).toBe(false);
  expect(existsSync(join(co, "new.txt"))).toBe(true);
  expect((await git(tools, co, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("towercab/261026-1000-x");
  // Base moves on the remote: refreshing brings it in by path.
  pushFiles(bare, { "b.txt": "b\n" });
  await git(tools, clone, ["fetch", "-q", "origin"]);
  await refreshBase(tools, clone, co, "main");
  expect(await git(tools, co, ["show", "refs/remotes/origin/main:b.txt"])).toBe("b\n");
});

test("checkout: has no remote", async () => {
  const clone = await cloneOf(bareRepo({ "a.txt": "a\n" }));
  const co = join(tempDir(), "co");
  await createCheckout(tools, clone, co, "main", "towercab/x");
  expect((await git(tools, co, ["remote"])).trim()).toBe("");
  expect(existsSync(`${co}.tmp`)).toBe(false);
});

test("checkout: a planted git config is refused", async () => {
  const clone = await cloneOf(bareRepo({ "a.txt": "a\n" }));
  const co = join(tempDir(), "co");
  await createCheckout(tools, clone, co, "main", "towercab/x");
  await gitSane(tools, co, ["status", "--short"]);
  tgit(co, "config", "core.sshCommand", "touch /tmp/pwned");
  await expect(gitSane(tools, co, ["status"])).rejects.toThrow(/core\.sshcommand, not written by Towercab/i);
});

test("cache: one cache per repo across missions", () => {
  const config = testConfig({
    agent: { env: { CRATE_CC_NO_DEFAULTS: "1" } },
    repos: { web: { github: "o/web", env: { FOO: "bar" } } },
  });
  const repo = config.repos.get("web")!;
  const a = cacheEnv(config, repo, "/h/cache/web");
  const b = cacheEnv(config, repo, "/h/cache/web");
  expect(a).toEqual(b);
  expect(a.CARGO_TARGET_DIR).toBe("/h/cache/web/target");
  expect(a.npm_config_cache).toBe("/h/cache/web/npm");
  expect(a.CRATE_CC_NO_DEFAULTS).toBe("1");
  expect(a.FOO).toBe("bar");
  expect(clonePath(repo, "/h")).toBe("/h/repos/web");
});
