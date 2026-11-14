// External programs behind one interface (LOOP-1 **Code**): git, gh, claude, bwrap, systemctl and the rest.
// The loop and every handler use `Tools`; tests pass fakes (tests/helpers/tools.ts).

import { spawn as nodeSpawn } from "node:child_process";
import { accessSync, closeSync, constants, openSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface RunOpts {
  cwd?: string;
  /** The whole environment; when absent the loop's own is used. */
  env?: Record<string, string>;
  /** Text written to stdin. */
  input?: string;
  /** Killed (whole group) after this long: `timed out after <n> s`. */
  timeoutMs?: number;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** A long-running child the loop reaps later (a Claude run, setup, checks). */
export interface ChildSpec {
  kind: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  /** File fed to stdin; none → /dev/null. */
  stdin?: string;
  stdout: string;
  stderr: string;
  /** Run-time budget left for this step. */
  timeoutMs?: number;
  /** Takes one of `[agent].parallel` slots (LOOP-4). */
  slot: boolean;
  /** A Claude run's `--model` (cooldowns, status). */
  model?: string;
}

export interface ChildExit {
  code: number | null;
  signal: string | null;
}

export interface ChildHandle {
  pid: number;
  done: Promise<ChildExit>;
  /** Signal the child's whole process group. */
  kill(signal: NodeJS.Signals): void;
}

export interface Tools {
  run(cmd: string, args: string[], opts?: RunOpts): Promise<RunResult>;
  spawn(spec: ChildSpec): ChildHandle;
  /** The absolute path of `cmd` on PATH, or null. */
  which(cmd: string): string | null;
  /**
   * LOOP-136: cut off every `run` call still in flight (SIGTERM to its group, SIGKILL `CUT_OFF_KILL_MS`
   * later); each resolves with `stopped: <cmd> was cut off at shutdown`. Returns what was cut off.
   * A Tools without it has nothing to cut off.
   */
  cutOff?(): string[];
}

export const GH_TIMEOUT_MS = 120_000;
export const GIT_TIMEOUT_MS = 300_000;
export const KILL_AFTER_MS = 10_000;
/** LOOP-136: how long running `gh` and `git` calls get once Towercab is told to stop. */
export const STOP_GRACE_MS = 10_000;
/** LOOP-136: SIGKILL follows a cut-off call's SIGTERM after this long. */
export const CUT_OFF_KILL_MS = 2_000;

/** Signal a process group, ignoring a group that is already gone. */
export function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Gone.
  }
}

export function realTools(): Tools {
  /** LOOP-136: the `run` calls in flight, each with what cuts it off. */
  const inFlight = new Set<{ label: string; cut: () => void }>();
  return {
    cutOff() {
      const cut = [...inFlight];
      inFlight.clear();
      for (const c of cut) c.cut();
      return cut.map((c) => c.label);
    },

    run(cmd, args, opts = {}) {
      return new Promise((resolve) => {
        const child = nodeSpawn(cmd, args, {
          cwd: opts.cwd,
          env: opts.env ?? process.env,
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let timer: NodeJS.Timeout | undefined;
        let killer: NodeJS.Timeout | undefined;
        child.stdout.setEncoding("utf8").on("data", (d: string) => {
          stdout += d;
        });
        child.stderr.setEncoding("utf8").on("data", (d: string) => {
          stderr += d;
        });
        if (opts.timeoutMs) {
          timer = setTimeout(() => {
            timedOut = true;
            if (child.pid) killGroup(child.pid, "SIGTERM");
            killer = setTimeout(() => child.pid && killGroup(child.pid, "SIGKILL"), KILL_AFTER_MS);
          }, opts.timeoutMs);
        }
        const entry = {
          label: [cmd, args[0]].filter(Boolean).join(" "),
          cut: () => {
            clearTimeout(timer);
            if (child.pid) killGroup(child.pid, "SIGTERM");
            clearTimeout(killer);
            killer = setTimeout(() => child.pid && killGroup(child.pid, "SIGKILL"), CUT_OFF_KILL_MS);
            resolve({
              code: null,
              stdout,
              stderr: `stopped: ${cmd} was cut off at shutdown\n`,
              timedOut: false,
            });
          },
        };
        inFlight.add(entry);
        child.on("error", (e) => {
          inFlight.delete(entry);
          clearTimeout(timer);
          resolve({ code: 127, stdout, stderr: `${stderr}${cmd}: ${e.message}\n`, timedOut: false });
        });
        child.on("close", (code) => {
          inFlight.delete(entry);
          clearTimeout(timer);
          clearTimeout(killer);
          if (timedOut) stderr += `timed out after ${Math.round((opts.timeoutMs ?? 0) / 1000)} s\n`;
          resolve({ code, stdout, stderr, timedOut });
        });
        child.stdin.on("error", () => {});
        child.stdin.end(opts.input ?? "");
      });
    },

    spawn(spec) {
      const [cmd, ...args] = spec.argv;
      const stdin = spec.stdin ? openSync(spec.stdin, "r") : "ignore";
      const out = openSync(spec.stdout, "w");
      const err = openSync(spec.stderr, "w");
      const child = nodeSpawn(cmd!, args, {
        cwd: spec.cwd,
        env: spec.env,
        detached: true,
        stdio: [stdin, out, err],
      });
      for (const fd of [stdin, out, err]) if (typeof fd === "number") closeSync(fd);
      const done = new Promise<ChildExit>((resolve) => {
        child.on("error", (e) => resolve({ code: 127, signal: `spawn failed: ${e.message}` }));
        child.on("exit", (code, signal) => resolve({ code, signal }));
      });
      return {
        pid: child.pid ?? -1,
        done,
        kill: (signal) => child.pid && killGroup(child.pid, signal),
      };
    },

    which(cmd) {
      if (cmd.includes("/")) return isExecutable(cmd) ? cmd : null;
      for (const dir of (process.env.PATH ?? "").split(delimiter)) {
        const p = join(dir, cmd);
        if (dir && isExecutable(p)) return p;
      }
      return null;
    },
  };
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Throw a readable error when a command failed: `<cmd> <first arg>: <stderr's first line>`. */
export function check(r: RunResult, what: string): string {
  if (r.code === 0) return r.stdout;
  const why =
    (r.stderr || r.stdout)
      .trim()
      .split("\n")
      .find((l) => l.trim()) ?? `exit ${r.code}`;
  throw new Error(`${what}: ${why}`);
}
