// The host's user-namespace restriction (PIP-162): on Ubuntu, `kernel.apparmor_restrict_unprivileged_userns = 1`
// blocks `bwrap` and Claude's own sandbox unless an AppArmor profile allows them. Towercab never turns the
// restriction off; this reads the state so the owner is told the one step, and Claude's own sandbox may use
// Unix sockets only while that step is still undone.

import { readFileSync } from "node:fs";
import type { Tools } from "../tools.ts";
import { apparmorProfile, type ProbeResult, sandboxProbe } from "./probe.ts";

export const RESTRICT_FILE = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";
export const PROFILE_FILE = "/etc/apparmor.d/towercab-bwrap";

export interface HostReader {
  /** The file's text, or null when it can't be read. */
  read(path: string): string | null;
}

export const realReader: HostReader = {
  read(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
};

export interface HostState {
  /** `apparmor_restrict_unprivileged_userns` is 1. */
  restricted: boolean;
  /** Towercab's AppArmor profile for `bwrap` is installed. */
  profile: boolean;
}

export function hostState(reader: HostReader = realReader): HostState {
  return {
    restricted: reader.read(RESTRICT_FILE)?.trim() === "1",
    profile: reader.read(PROFILE_FILE)?.includes("userns") ?? false,
  };
}

/** Whether the owner still has to install the profile: the restriction is on and the profile is missing. Then no Claude run starts. */
export function needsProfile(s: HostState): boolean {
  return s.restricted && !s.profile;
}

/** The owner's one step, or null when there is none: the exact commands to install the profile. */
export function profileStep(
  s: HostState,
  bwrap: string,
): { title: string; commands: string; oneLine: string } | null {
  if (!needsProfile(s)) return null;
  const file = apparmorProfile(bwrap)
    .filter((l) => !l.startsWith("#"))
    .join("\n");
  return {
    title: "Allow Towercab's sandbox on this machine",
    oneLine: `printf '%s\\n' ${file
      .split("\n")
      .map((l) => `'${l}'`)
      .join(" ")} | sudo tee ${PROFILE_FILE} >/dev/null && sudo apparmor_parser -r ${PROFILE_FILE}`,
    commands: `sudo tee ${PROFILE_FILE} >/dev/null <<'EOF'\n${file}\nEOF\nsudo apparmor_parser -r ${PROFILE_FILE}`,
  };
}

/**
 * The failure text the owner sees (PIP-162, PIP-163): the probe's own error, and, only when user namespaces are
 * restricted and Towercab's profile is missing, the one step with the exact install command.
 */
export function sandboxFailure(probe: ProbeResult, host: HostState, bwrap: string): string {
  const step = profileStep(host, bwrap);
  return step ? `${step.title}: ${probe.why}. Run: ${step.oneLine}` : probe.why;
}

/** Runs the real probe first; refuses only when it fails (a working sandbox never gets the card). */
export async function checkSandbox(tools: Tools, reader: HostReader = realReader): Promise<ProbeResult> {
  const probe = await sandboxProbe(tools);
  if (probe.ok) return probe;
  return {
    ok: false,
    why: sandboxFailure(probe, hostState(reader), tools.which("bwrap") ?? "/usr/bin/bwrap"),
  };
}
