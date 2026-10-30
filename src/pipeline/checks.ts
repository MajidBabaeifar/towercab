// Sandboxed commands (PIP-23 **Sandbox**): the repo's setup, checks and screenshots as one child each,
// every command echoed as `$ <command>` before its output.

import { homedir } from "node:os";
import { join } from "node:path";
import type { Ctx } from "../handlers.ts";
import type { Mission } from "../mission.ts";
import { quote } from "../repo/runset.ts";
import type { ChildSpec } from "../tools.ts";
import { cacheEnv, sandboxArgv, sandboxEnv } from "./sandbox.ts";

/** A shell script running each line in order, stopping at the first failure. */
export function script(lines: string[]): string {
  return lines.map((l) => `printf '%s\\n' ${quote(`$ ${l}`)}\n${l} || exit $?`).join("\n");
}

export interface SandboxRun {
  kind: "setup" | "checks" | "proof-setup" | "proof" | "proof-head" | "shots" | "e2e-setup" | "e2e";
  lines: string[];
  /** The checkout to run in (the mission's, or the proof's). */
  dir: string;
  network: boolean;
  cacheWritable: boolean;
  log: string;
  timeoutMs: number;
  extraEnv?: Record<string, string>;
}

export function sandboxSpec(cx: Ctx, m: Mission, r: SandboxRun): ChildSpec {
  const repo = cx.repo(m);
  const cache = cx.home.cache(repo.name);
  const home = homedir();
  return {
    kind: r.kind,
    argv: sandboxArgv({
      checkout: r.dir,
      home,
      toolchain: cx.config.agent.toolchain,
      cache,
      network: r.network,
      cacheWritable: r.cacheWritable,
      line: script(r.lines),
    }),
    cwd: r.dir,
    env: { ...sandboxEnv(home, cx.config, cacheEnv(cache, cx.config, repo)), ...(r.extraEnv ?? {}) },
    stdout: r.log,
    stderr: `${r.log}.err`,
    timeoutMs: r.timeoutMs,
    slot: true,
  };
}

/** A log in the stage's folder (LOOP-39). */
export function logPath(cx: Ctx, m: Mission, stage: string, name: string): string {
  return join(cx.runs(m, stage), name);
}
