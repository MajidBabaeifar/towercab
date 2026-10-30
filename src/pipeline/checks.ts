// Sandboxed commands (PIP-23 **Sandbox**): the repo's setup, checks and screenshots as one child each,
// every command echoed as `$ <command>` before its output; checks that must write to the repo cache
// ask the owner first (PIP-95).

import { homedir } from "node:os";
import { join } from "node:path";
import type { Ctx } from "../handlers.ts";
import type { Mission } from "../mission.ts";
import { quote } from "../repo/runset.ts";
import type { ChildSpec } from "../tools.ts";
import { cacheEnv, sandboxArgv, sandboxEnv } from "./sandbox.ts";
import type { Question } from "./schemas.ts";

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

/** The `meta` key that remembers PIP-95's permission for `repo`. */
export const checksWriteKey = (repo: string): string => `checks-write:${repo}`;

/** The owner let this repo's checks, proof, screenshots and e2e write to its cache (PIP-95). */
export function checksMayWrite(cx: Ctx, m: Mission): boolean {
  return cx.db.meta(checksWriteKey(cx.repo(m).name)) === "1";
}

const READ_ONLY = /Read-only file system|os error 30|Errno 30|EROFS/i;

/**
 * A read-only error in a checks log that names a path under `cache` (PIP-95): that path and the
 * command that ran (its `$ <command>` line), or null.
 */
export function readOnlyCachePath(
  log: string,
  cache: string,
): { path: string; command: string | null } | null {
  const root = cache.replace(/\/+$/, "");
  const lines = log.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!READ_ONLY.test(lines[i]!)) continue;
    for (let j = i; j >= Math.max(0, i - 3); j--) {
      const path = (lines[j]!.match(/\/[^\s'"`,:;()]+/g) ?? []).find(
        (p) => p === root || p.startsWith(`${root}/`),
      );
      if (!path) continue;
      const command = lines
        .slice(0, j + 1)
        .reverse()
        .find((l) => l.startsWith("$ "));
      return { path, command: command ? command.slice(2).trim() : null };
    }
  }
  return null;
}

/** PIP-95's question: may the checks of `repo` write to its build cache? */
export function cacheWriteQuestion(
  repo: string,
  cache: string,
  ro: { path: string; command: string | null },
): Question {
  const who = ro.command ? `\`${ro.command}\`` : "A check";
  return {
    context: `The checks stopped before testing anything. ${who} tried to write \`${ro.path}\`, and the sandbox refused, because Towercab runs the checks with ${repo}'s build cache (\`${cache}\`) read-only. Setup and the worker may write there; the checks may not, so they can't change what was built. Some tools have to write there just to run: cargo, for example, keeps its build output and its lock file in the cache. The code is not at fault, so Towercab did not send this to the worker.`,
    question: `May the checks of ${repo} write to its build cache?`,
    options: [
      {
        option: "Allow",
        // biome-ignore lint/suspicious/noThenProperty: the question schema's key; never awaited.
        then: `Towercab remembers this for ${repo} and runs the checks again; later missions of ${repo} don't ask. Its checks, proof, screenshots and e2e can then change the shared cache, as setup and the worker already can.`,
      },
      {
        option: "Don't allow",
        // biome-ignore lint/suspicious/noThenProperty: the question schema's key; never awaited.
        then: `The intent waits as "checks red". To go on, make the checks write inside the checkout (for example set CARGO_TARGET_DIR under [repos.${repo}].env in Towercab's config) and reply, or drop the intent.`,
      },
    ],
    recommendation:
      "Allow. Setup and the worker already write to this cache, so letting the checks write too adds little risk, and without it these checks can't run at all.",
  };
}

/** PIP-95: an answer that starts with allow, yes or ok allows; anything else doesn't. */
export function allowsCacheWrite(answer: string | undefined): boolean {
  return /^\s*(allow|yes|ok)\b/i.test(answer ?? "");
}
