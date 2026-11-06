// The sandbox argv (PIP-23 **Sandbox**) and the repo's shared build cache (LOOP-34).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Home } from "../../src/home.ts";
import {
  cacheEnv,
  sandboxArgv,
  sandboxEnv,
  sandboxPath,
  withProxy as withProxyLine,
} from "../../src/pipeline/sandbox.ts";
import { tempDir, testConfig } from "../helpers/world.ts";

test("pipeline: sandbox argv", () => {
  const home = tempDir();
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "credentials.toml"), "token");
  writeFileSync(join(bin, ".npmrc"), "//registry:_authToken=x");
  const o = {
    checkout: "/h/work/261001-0900-1",
    home,
    cache: "/h/cache/web",
    cacheWritable: false,
    line: "npm test",
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
  const tail = (bind: string, line: string) => [
    "--tmpfs",
    home,
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
    line,
  ];
  // No proxy: no network at all, nothing bound for one.
  expect(sandboxArgv(o)).toEqual(["bwrap", "--unshare-net", ...common, ...tail("--ro-bind", "npm test")]);
  // Setup: the cache writable and a proxy: the node, the bridge and the socket are bound after /run is
  // a tmpfs, and the line starts the bridge first. The network is still unshared (PIP-158).
  const sock = "/tmp/tc-proxy-1/abc.sock";
  const withProxy = sandboxArgv({ ...o, cacheWritable: true, proxy: sock });
  expect(withProxy.slice(0, 2)).toEqual(["bwrap", "--unshare-net"]);
  const run = withProxy.indexOf("/run");
  expect(withProxy.slice(run + 1, run + 10)).toEqual([
    "--ro-bind",
    process.execPath,
    "/run/tc/node",
    "--ro-bind",
    expect.stringMatching(/proxy-bridge\.ts$/),
    "/run/tc/bridge.ts",
    "--bind",
    sock,
    "/run/tc/proxy.sock",
  ]);
  expect(withProxy.at(-3)).toBe("sh");
  expect(withProxy.at(-1)).toBe(withProxyLine("npm test"));
  expect(withProxy.at(-1)).toContain("HTTPS_PROXY=http://127.0.0.1:3128");
  expect(withProxy).toContain("--bind");
  // No cache, a custom bwrap.
  const plain = sandboxArgv({ ...o, cache: null, bwrap: "/usr/bin/bwrap" });
  expect(plain[0]).toBe("/usr/bin/bwrap");
  expect(plain).not.toContain("/h/cache/web");
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
  // `[agent].env` is ignored (PIP-157); `[repos.<r>].env` comes last when it passes PIP-159.
  const env = cacheEnv(first, web);
  expect(env).toEqual({
    XDG_CACHE_HOME: join(first, "xdg"),
    npm_config_cache: join(first, "npm"),
    CARGO_HOME: join(first, "cargo"),
    CARGO_TARGET_DIR: join(first, "target"),
    GOCACHE: "/repo/go",
    PIP_CACHE_DIR: join(first, "pip"),
  });
  expect(cacheEnv(home.cache("api"), config.repos.get("api")!).CARGO_HOME).toBe(
    join(home.root, "cache", "api", "cargo"),
  );
  const sb = sandboxEnv("/home/me", config, env);
  expect(sb).toMatchObject({
    HOME: "/home/me",
    PATH: sandboxPath("/home/me"),
    TMPDIR: "/tmp",
    GOCACHE: "/repo/go",
  });
});
