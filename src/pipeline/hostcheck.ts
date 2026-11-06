// The host's user-namespace restriction (PIP-162): on Ubuntu, `kernel.apparmor_restrict_unprivileged_userns = 1`
// blocks `bwrap` and Claude's own sandbox unless an AppArmor profile allows them. Towercab never turns the
// restriction off; this reads the state so the owner is told the one step, and Claude's own sandbox may use
// Unix sockets only while that step is still undone.

import { readFileSync } from "node:fs";
import { apparmorProfile } from "./probe.ts";

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
