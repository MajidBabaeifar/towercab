// Under WSL the Windows drives and the interop sockets are hidden from workers (LOOP-163).

import { expect, test } from "vitest";
import { type ClaudeRun, claudeEnv, claudeSettings, HOST_SOCKETS } from "../src/claude.ts";
import { envRefusal, sandboxArgv, sandboxEnv } from "../src/pipeline/sandbox.ts";
import { INTEROP_VARS, isWslHost } from "../src/wsl.ts";
import { testConfig } from "./helpers/world.ts";

function wslRun(over: Partial<ClaudeRun> = {}): ClaudeRun {
  return {
    kind: "worker",
    model: "opus",
    cwd: "/h/work/261001-0900-1",
    runsDir: "/h/runs/261001-0900",
    n: 1,
    prompt: "do it",
    session: { mode: "none", id: "" },
    claudeMd: "",
    grants: { domains: [], paths: [], open: false },
    cacheEnv: {},
    config: testConfig({}, "/cfg/config.toml"),
    ...over,
  };
}

const base = { checkout: "/work/c", home: "/home/u", cache: null, cacheWritable: false, line: "true" };

test("sandbox: WSL drives and interop are hidden from workers", () => {
  // /mnt is an empty tmpfs in the bwrap argv, under WSL only, before the checkout is bound.
  const wsl = sandboxArgv({ ...base, wsl: true });
  const at = wsl.findIndex((x, i) => x === "--tmpfs" && wsl[i + 1] === "/mnt");
  expect(at).toBeGreaterThan(0);
  expect(at).toBeLessThan(wsl.indexOf("--bind"));
  expect(sandboxArgv({ ...base, wsl: false })).not.toContain("/mnt");
  // The Claude run's own sandbox cannot read /mnt either, and /run/WSL is a host socket.
  const deny = (w: boolean) =>
    (
      claudeSettings(wslRun(), { towercabExe: "/x/towercab", home: "/home/u", wsl: w }) as {
        sandbox: { filesystem: { denyRead: string[] } };
      }
    ).sandbox.filesystem.denyRead;
  expect(deny(true)).toContain("/mnt");
  expect(deny(false)).not.toContain("/mnt");
  expect(HOST_SOCKETS).toContain("/run/WSL");
  expect(deny(false)).toContain("/run/WSL");
  expect(isWslHost(() => "5.15.1-microsoft-standard-WSL2")).toBe(true);
  expect(isWslHost(() => "6.8.0-generic")).toBe(false);
  expect(
    isWslHost(() => {
      throw new Error("no proc");
    }),
  ).toBe(false);
});

test("sandbox: WSL interop variables are not passed to runs", () => {
  const saved = { ...process.env };
  for (const k of INTEROP_VARS) process.env[k] = "/run/WSL/1_interop";
  try {
    const cache = { WSL_INTEROP: "x", XDG_CACHE_HOME: "/c" };
    for (const env of [claudeEnv(wslRun({ cacheEnv: cache }), "/home/u"), sandboxEnv("/home/u", null, cache)])
      for (const k of INTEROP_VARS) expect(env[k]).toBeUndefined();
    expect(sandboxEnv("/home/u", null, cache).XDG_CACHE_HOME).toBe("/c");
    expect(envRefusal("WSL_INTEROP", "/run/WSL/1_interop")).toMatch(/Windows programs/);
  } finally {
    for (const k of INTEROP_VARS) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
