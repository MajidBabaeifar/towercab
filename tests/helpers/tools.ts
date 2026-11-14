// Fake external programs (LOOP-1 **Code**). A FakeTools answers `run` from handlers registered per
// command, and `spawn` from scripted children; `git` passes through to the real one by default.

import { writeFileSync } from "node:fs";
import type { ChildExit, ChildHandle, ChildSpec, RunOpts, RunResult, Tools } from "../../src/tools.ts";
import { realTools } from "../../src/tools.ts";

export type RunFn = (args: string[], opts: RunOpts) => RunResult | Promise<RunResult>;
export type SpawnFn = (spec: ChildSpec) => ChildExit | Promise<ChildExit>;

export interface Call {
  cmd: string;
  args: string[];
  opts: RunOpts;
}

export const okResult = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "", timedOut: false });
export const failResult = (stderr: string, code = 1): RunResult => ({
  code,
  stdout: "",
  stderr,
  timedOut: false,
});

export class FakeTools implements Tools {
  readonly calls: Call[] = [];
  readonly spawned: ChildSpec[] = [];
  private runs = new Map<string, RunFn>();
  private spawns = new Map<string, SpawnFn[]>();
  private real = realTools();
  private nextPid = 50_000;
  /** Commands that `which` finds. */
  readonly present = new Set(["git", "gh", "claude", "bwrap", "systemctl", "systemd-inhibit", "journalctl"]);

  constructor() {
    this.on("git", (args, opts) => this.real.run("git", args, opts));
  }

  /** Answer every `cmd` call with `fn` (replaces an earlier handler). */
  on(cmd: string, fn: RunFn): this {
    this.runs.set(cmd, fn);
    return this;
  }

  /** Queue a child for the next `spawn` whose argv[0] is `cmd` (FIFO); it writes stdout/stderr files. */
  child(cmd: string, fn: SpawnFn): this {
    const q = this.spawns.get(cmd) ?? [];
    q.push(fn);
    this.spawns.set(cmd, q);
    return this;
  }

  /** `run` calls not answered yet; `cutOff` answers them with the stopped result (LOOP-136). */
  private pending = new Set<{ label: string; cmd: string; cut: (r: RunResult) => void }>();

  async run(cmd: string, args: string[], opts: RunOpts = {}): Promise<RunResult> {
    this.calls.push({ cmd, args, opts });
    const fn = this.runs.get(cmd);
    if (!fn) return failResult(`${cmd}: not faked`, 127);
    const entry = { label: [cmd, args[0]].filter(Boolean).join(" "), cmd, cut: (_r: RunResult) => {} };
    const answer = fn(args, opts);
    return new Promise<RunResult>((resolve, reject) => {
      entry.cut = resolve;
      this.pending.add(entry);
      Promise.resolve(answer)
        .then(resolve, reject)
        .finally(() => this.pending.delete(entry));
    });
  }

  cutOff(): string[] {
    const cut = [...this.pending];
    this.pending.clear();
    for (const c of cut) c.cut(failResult(`stopped: ${c.cmd} was cut off at shutdown`, 1));
    return cut.map((c) => c.label);
  }

  spawn(spec: ChildSpec): ChildHandle {
    this.spawned.push(spec);
    const cmd = spec.argv[0]!;
    const q = this.spawns.get(cmd) ?? this.spawns.get(cmd.split("/").pop()!) ?? [];
    const fn = q.shift();
    let killed: ChildExit | null = null;
    let resolveKill: ((e: ChildExit) => void) | null = null;
    const killedP = new Promise<ChildExit>((r) => {
      resolveKill = r;
    });
    const done = (async (): Promise<ChildExit> => {
      if (!fn) {
        writeFileSync(spec.stdout, "");
        writeFileSync(spec.stderr, `${cmd}: no child queued\n`);
        return { code: 127, signal: null };
      }
      const res = await Promise.race([Promise.resolve(fn(spec)), killedP]);
      return killed ?? res;
    })();
    return {
      pid: this.nextPid++,
      done,
      kill: (signal) => {
        killed = { code: null, signal };
        resolveKill?.(killed);
      },
    };
  }

  which(cmd: string): string | null {
    return this.present.has(cmd) ? `/usr/bin/${cmd}` : null;
  }

  /** Calls to `cmd`, as `args.join(" ")`. */
  lines(cmd: string): string[] {
    return this.calls.filter((c) => c.cmd === cmd).map((c) => c.args.join(" "));
  }
}
