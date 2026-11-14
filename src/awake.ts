// Stay awake while driving (LOOP-11, LOOP-142): one `systemd-inhibit … sleep infinity` child (under WSL a
// `powershell.exe` one) while any mission is driven; and wake detection, so no wait timeout fires before its wait has polled again.

import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildHandle, Tools } from "./tools.ts";
import { POWERSHELL, powershellPath } from "./wsl.ts";

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

/** `ES_CONTINUOUS | ES_SYSTEM_REQUIRED` (0x80000001): Windows stays awake while this thread lives. */
export const ES_SYSTEM_REQUIRED_CONTINUOUS = 0x80000001;

/** LOOP-142: the `powershell.exe` command line that holds Windows awake until it is killed. */
export function wslInhibitArgv(program: string = POWERSHELL): string[] {
  const script = [
    "Add-Type -Namespace Towercab -Name Power -MemberDefinition",
    "'[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);';",
    `[void][Towercab.Power]::SetThreadExecutionState(${ES_SYSTEM_REQUIRED_CONTINUOUS});`,
    "while ($true) { Start-Sleep -Seconds 3600 }",
  ].join(" ");
  return [program, "-NoProfile", "-NonInteractive", "-Command", script];
}

export class Inhibitor {
  private wsl = false;
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

  /** LOOP-142: under WSL the inhibitor is a `powershell.exe` child instead of `systemd-inhibit`. */
  setWsl(wsl: boolean): void {
    this.wsl = wsl;
  }

  /** PATH, and under WSL the variables the Windows interop needs (when set). */
  private env(): Record<string, string> {
    const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
    if (this.wsl)
      for (const k of ["WSL_INTEROP", "WSL_DISTRO_NAME", "WSLENV"]) {
        const v = process.env[k];
        if (v) env[k] = v;
      }
    return env;
  }

  private get program(): string {
    return this.wsl ? POWERSHELL : "systemd-inhibit";
  }

  get running(): boolean {
    return this.child !== null && !this.exited;
  }

  /** `driving`: `<id> <stage>` of the first driven mission, or null. Not restarted on stage changes. */
  update(driving: string | null, mono: number): void {
    if (this.child && this.exited) {
      this.log(`${this.program} exited; retrying in 60 s`);
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
        argv: this.wsl
          ? wslInhibitArgv(powershellPath(this.tools) ?? POWERSHELL)
          : ["systemd-inhibit", ...inhibitArgs(driving)],
        cwd: "/",
        env: this.env(),
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
      this.log(`${this.program}: ${(e as Error).message}`);
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
