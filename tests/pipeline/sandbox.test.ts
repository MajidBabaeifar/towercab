// The sandbox argv (PIP-23 **Sandbox**) and the repo's shared build cache (LOOP-34).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Home } from "../../src/home.ts";
import { cacheEnv, sandboxArgv, sandboxEnv } from "../../src/pipeline/sandbox.ts";
import { tempDir, testConfig } from "../helpers/world.ts";

test("pipeline: sandbox argv", () => {
  const root = tempDir();
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "credentials.toml"), "token");
  writeFileSync(join(bin, ".npmrc"), "//registry:_authToken=x");
  const o = {
    checkout: "/h/work/261001-0900-1",
    home: "/home/me",
    toolchain: [bin, join(root, "missing")],
    cache: "/h/cache/web",
    network: false,
    cacheWritable: false,
    line: "npm test",
    resolv: "/run/systemd/resolve/stub-resolv.conf",
  };
  const common = [
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--new-session",
    "--die-with-parent",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/run",
  ];
  const tail = (bind: string) => [
    "--tmpfs",
    "/home/me",
    "--tmpfs",
    "/tmp",
    "--ro-bind",
    bin,
    bin,
    "--ro-bind",
    "/dev/null",
    join(bin, "credentials.toml"),
    "--ro-bind",
    "/dev/null",
    join(bin, ".npmrc"),
    bind,
    "/h/cache/web",
    "/h/cache/web",
    "--bind",
    "/h/work/261001-0900-1",
    "/h/work/261001-0900-1",
    "--ro-bind-try",
    "/h/work/261001-0900-1/.git",
    "/h/work/261001-0900-1/.git",
    "--chdir",
    "/h/work/261001-0900-1",
    "--",
    "sh",
    "-c",
    "npm test",
  ];
  // Checks: no network, no resolv.conf.
  expect(sandboxArgv(o)).toEqual(["bwrap", "--unshare-net", ...common, ...tail("--ro-bind")]);
  // Setup: network, resolv.conf bound back, the cache writable.
  expect(sandboxArgv({ ...o, network: true, cacheWritable: true })).toEqual([
    "bwrap",
    ...common,
    "--ro-bind-try",
    o.resolv,
    o.resolv,
    ...tail("--bind"),
  ]);
  // No cache, no resolv.conf to bind.
  const plain = sandboxArgv({ ...o, network: true, cache: null, resolv: null, bwrap: "/usr/bin/bwrap" });
  expect(plain[0]).toBe("/usr/bin/bwrap");
  expect(plain).not.toContain("/h/cache/web");
  expect(plain).not.toContain(o.resolv);
});

test("cache: one cache per repo across missions", () => {
  const home = new Home(tempDir());
  const config = testConfig({
    agent: { env: { CRATE_CC_NO_DEFAULTS: "1", npm_config_cache: "/agent/npm" } },
    repos: { web: { github: "owner/web", env: { GOCACHE: "/repo/go" } }, api: { github: "owner/api" } },
  });
  const web = config.repos.get("web")!;
  // Every mission of a repo gets the same directory; another repo another one.
  const first = home.cache("web");
  expect(home.cache("web")).toBe(first);
  expect(home.cache("api")).not.toBe(first);
  const env = cacheEnv(first, config, web);
  expect(env).toEqual({
    XDG_CACHE_HOME: join(first, "xdg"),
    // `[agent].env` after the cache's variables, `[repos.<r>].env` last.
    npm_config_cache: "/agent/npm",
    CARGO_HOME: join(first, "cargo"),
    CARGO_TARGET_DIR: join(first, "target"),
    GOCACHE: "/repo/go",
    PIP_CACHE_DIR: join(first, "pip"),
    CRATE_CC_NO_DEFAULTS: "1",
  });
  expect(cacheEnv(home.cache("api"), config, config.repos.get("api")!).CARGO_HOME).toBe(
    join(home.root, "cache", "api", "cargo"),
  );
  const sb = sandboxEnv("/home/me", config, env);
  expect(sb).toMatchObject({
    HOME: "/home/me",
    PATH: config.agent.path,
    TMPDIR: "/tmp",
    GOCACHE: "/repo/go",
  });
});
