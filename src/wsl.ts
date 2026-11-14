// Windows through WSL2 (LOOP-142, LOOP-143): is this WSL, is systemd PID 1, and what the Windows
// user's `.wslconfig` says. Everything is read through `Tools`, so tests fake it and a host without
// `cat` or `powershell.exe` simply answers "no".

import type { Tools } from "./tools.ts";

/** The Windows program that holds the machine awake and reads `.wslconfig`. */
export const POWERSHELL = "powershell.exe";

/** The kernel release when it contains `microsoft` (case-insensitive), else null: not WSL. */
export async function detectWsl(tools: Tools): Promise<string | null> {
  const r = await tools.run("cat", ["/proc/sys/kernel/osrelease"], { timeoutMs: 5000 }).catch(() => null);
  const release = r && r.code === 0 ? r.stdout.trim() : "";
  return /microsoft/i.test(release) ? release : null;
}

/** LOOP-143: `/proc/1/comm` says `systemd`. */
export async function pid1IsSystemd(tools: Tools): Promise<boolean> {
  const r = await tools.run("cat", ["/proc/1/comm"], { timeoutMs: 5000 }).catch(() => null);
  return r !== null && r.code === 0 && r.stdout.trim() === "systemd";
}

/** A path inside the Windows drives, which cannot hold mode 600. */
export function isUnderMnt(path: string): boolean {
  return path === "/mnt" || path.startsWith("/mnt/");
}

/** The text of `%UserProfile%\.wslconfig` (empty when there is none), or null when it can't be read. */
export async function readWslConfig(tools: Tools): Promise<string | null> {
  const script =
    "$p = Join-Path $env:USERPROFILE '.wslconfig'; if (Test-Path -LiteralPath $p) { Get-Content -Raw -LiteralPath $p }";
  const r = await tools
    .run(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", script], { timeoutMs: 20_000 })
    .catch(() => null);
  return r && r.code === 0 ? r.stdout : null;
}

/** True when `[wsl2]` sets `vmIdleTimeout` (any value; a comment or another section doesn't count). */
export function hasVmIdleTimeout(wslconfig: string): boolean {
  let section = "";
  for (const raw of wslconfig.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const head = /^\[([^\]]+)\]$/.exec(line);
    if (head) {
      section = head[1]!.trim().toLowerCase();
      continue;
    }
    if (section === "wsl2" && /^vmidletimeout\s*=\s*\S/i.test(line)) return true;
  }
  return false;
}
