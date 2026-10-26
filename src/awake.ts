// Stay awake while driving (LOOP-11): one `systemd-inhibit … sleep infinity` child while any mission
// is driven; and wake detection, so no wait timeout fires before its wait has polled again.

import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildHandle, Tools } from "./tools.ts";

/** After the inhibitor fails to start or exits on its own, the next try waits this long (ms). */
export const RETRY_MS = 60_000;

export function inhibitArgs(why: string): string[] {
  return [
    "--what=sleep:idle:handle-lid-switch",
    "--who=Towercab",
    `--why=${why}`,
    "--mode=block",
    "sleep",
    "infinity",
  ];
}

export class Inhibitor {
  private child: ChildHandle | null = null;
  private exited = false;
  private retryAt = 0;
  why: string | null = null;
  private tools: Tools;
  private log: (line: string) => void;

  constructor(tools: Tools, log: (line: string) => void) {
    this.tools = tools;
    this.log = log;
  }

  get running(): boolean {
    return this.child !== null && !this.exited;
  }

  /** `driving`: `<id> <stage>` of the first driven mission, or null. Not restarted on stage changes. */
  update(driving: string | null, mono: number): void {
    if (this.child && this.exited) {
      this.log("systemd-inhibit exited; retrying in 60 s");
      this.child = null;
      this.retryAt = mono + RETRY_MS;
    }
    if (driving === null) {
      this.stop();
      return;
    }
    if (this.child || mono < this.retryAt) return;
    const out = join(tmpdir(), "towercab-inhibit.log");
    try {
      const child = this.tools.spawn({
        kind: "inhibit",
        argv: ["systemd-inhibit", ...inhibitArgs(driving)],
        cwd: "/",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        stdout: out,
        stderr: out,
        slot: false,
      });
      this.child = child;
      this.exited = false;
      this.why = driving;
      void child.done.then(() => {
        if (this.child === child) this.exited = true;
      });
    } catch (e) {
      this.log(`systemd-inhibit: ${(e as Error).message}`);
      this.retryAt = mono + RETRY_MS;
    }
  }

  stop(): void {
    if (this.child) this.child.kill("SIGKILL");
    this.child = null;
    this.why = null;
  }
}

/**
 * Woke from suspend: the wall clock ran ahead of the monotonic one (which stops in suspend) by more
 * than 3 passes since the last pass.
 */
export function woke(
  last: { wall: number; mono: number },
  now: { wall: number; mono: number },
  passS: number,
): boolean {
  const wallS = now.wall - last.wall;
  const monoS = (now.mono - last.mono) / 1000;
  return wallS - monoS > 3 * passS;
}
