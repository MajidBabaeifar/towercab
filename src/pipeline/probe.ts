// The start probe (PIP-163): through the production builder, proves the sandbox on this machine holds before
// a mission runs: a planted secret outside the checkout can't be read, `.git` can't be written, there is
// no network without a grant, and a command inside can start a sandbox of its own (Claude's shell does).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tools } from "../tools.ts";
import { sandboxArgv } from "./sandbox.ts";

export interface ProbeResult {
  ok: boolean;
  /** One line: what held, or what failed. */
  why: string;
}

const NESTED_EXIT = 24;

/** What the probe says when a command inside the sandbox may not create a user namespace. */
export const NESTED_WHY =
  "a command inside the sandbox can't start a sandbox of its own, so a worker's shell commands would all fail";

const SCRIPT = [
  `cat "$HOME/.ssh/canary" 2>/dev/null && exit 21`,
  `(echo x > .git/probe) 2>/dev/null && exit 22`,
  `[ "$(tail -n +3 /proc/net/dev | wc -l)" = 1 ] || exit 23`,
  // Claude's own sandbox starts every shell command in a user namespace of its own; where that is refused
  // (Ubuntu's stock `bwrap` profile), a worker has no shell at all and builds blind.
  `if command -v unshare >/dev/null 2>&1; then unshare -Ur true 2>/dev/null || exit ${NESTED_EXIT}; fi`,
  `echo held`,
].join("\n");

const EXIT_WHY: Record<number, string> = {
  21: "a secret outside the checkout could be read",
  22: "the checkout's .git could be written",
  23: "the sandbox has a network interface without a grant",
  [NESTED_EXIT]: NESTED_WHY,
};

/** True when a probe failure reads like Ubuntu's restriction on unprivileged user namespaces (PIP-162). */
export function userNamespaceDenied(why: string): boolean {
  return /uid map|setting up uid|Operation not permitted|Permission denied|user namespace|userns/i.test(why);
}

/** PIP-162: the narrow fix: an AppArmor profile that lets only this `bwrap` binary create user namespaces. */
export function apparmorProfile(bwrap: string): string[] {
  return [
    `# save as /etc/apparmor.d/towercab-bwrap, then run: sudo apparmor_parser -r /etc/apparmor.d/towercab-bwrap`,
    "abi <abi/4.0>,",
    "include <tunables/global>",
    `profile towercab-bwrap ${bwrap} flags=(unconfined) {`,
    "  userns,",
    "}",
  ];
}

/** Runs the probe with the real `bwrap`; a start failure is reported with bwrap's own words. */
export async function sandboxProbe(tools: Tools): Promise<ProbeResult> {
  const bwrap = tools.which("bwrap");
  if (!bwrap) return { ok: false, why: "bwrap is not installed" };
  const root = mkdtempSync(join(tmpdir(), "tc-probe-"));
  try {
    const home = join(root, "home");
    const checkout = join(root, "checkout");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    mkdirSync(join(checkout, ".git"), { recursive: true });
    writeFileSync(join(home, ".ssh", "canary"), "probe canary");
    const argv = sandboxArgv({
      checkout,
      home,
      cache: null,
      proxy: null,
      cacheWritable: false,
      line: SCRIPT,
      bwrap,
    });
    const r = await tools.run(argv[0]!, argv.slice(1), {
      cwd: checkout,
      env: { HOME: home, PATH: "/usr/bin:/bin" },
      timeoutMs: 30_000,
    });
    if (r.code === 0 && r.stdout.includes("held")) return { ok: true, why: "held" };
    const known = EXIT_WHY[r.code ?? -1];
    if (known) return { ok: false, why: known };
    const said = (r.stderr || r.stdout).trim().split("\n").filter(Boolean).slice(-1)[0] ?? `exit ${r.code}`;
    return { ok: false, why: `the sandbox can't start: ${said.slice(0, 200)}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
