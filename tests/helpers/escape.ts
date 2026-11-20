// Real-bwrap runs for the escape suite (PIP-160): the production argv and environment, a planted HOME with
// fake secrets, a checkout with a `.git`. Without a usable bwrap each attempt is skipped with a note, except
// in GitHub Actions, where CI installs bwrap and the AppArmor profile and a missing one fails.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandboxArgv, sandboxEnv } from "../../src/pipeline/sandbox.ts";

/** True when `bwrap` can create the namespaces the sandbox needs on this machine. */
export function bwrapUsable(): boolean {
  const r = spawnSync("bwrap", ["--unshare-net", "--ro-bind", "/", "/", "true"], { encoding: "utf8" });
  return r.status === 0;
}

/** True where CI must have bwrap: a missing one fails there instead of skipping (PIP-160). */
export const BWRAP_REQUIRED = process.env.GITHUB_ACTIONS === "true";

/** The note an attempt skipped for want of bwrap carries. */
export const SKIP_NOTE = "skipped: no bwrap";

/** What to do with the attempts: run them, skip them with the note, or fail because CI must have bwrap. */
export function escapeMode(usable: boolean, required: boolean): "run" | "skip" | "fail" {
  if (usable) return "run";
  return required ? "fail" : "skip";
}

export interface Plant {
  /** The fake HOME (the sandbox hides it), a sibling checkout with `.git`, and a file outside both. */
  base: string;
  home: string;
  checkout: string;
  outside: string;
  cleanup(): void;
}

/** A fake HOME with secrets in the places `~/.ssh`, `~/.config/gh`, `~/.claude` and the App key live. */
export function plant(): Plant {
  // Under the repo, not /tmp: the sandbox's tmpfs /tmp would hide the secrets for the wrong reason.
  const base = mkdtempSync(join(process.cwd(), ".escape-"));
  const home = join(base, "home");
  const checkout = join(base, "checkout");
  for (const d of [".ssh", ".config/gh", ".config/towercab", ".claude"])
    mkdirSync(join(home, d), { recursive: true });
  mkdirSync(join(checkout, ".git", "hooks"), { recursive: true });
  writeFileSync(join(home, ".ssh", "id_ed25519"), "SSH-CANARY");
  writeFileSync(join(home, ".config", "gh", "hosts.yml"), "oauth_token: GH-CANARY");
  writeFileSync(join(home, ".claude", ".credentials.json"), "CLAUDE-CANARY");
  writeFileSync(join(home, ".config", "towercab", "app.pem"), "APP-KEY-CANARY");
  writeFileSync(join(base, "outside.txt"), "outside");
  return {
    base,
    home,
    checkout,
    outside: join(base, "outside.txt"),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

/** Runs `line` in the real sandbox, built by the production builder, with the production environment. */
export function inSandbox(
  p: Plant,
  line: string,
  o: { proxy?: string | null } = {},
): { code: number | null; out: string } {
  const argv = sandboxArgv({
    checkout: p.checkout,
    home: p.home,
    cache: null,
    cacheWritable: false,
    line,
    proxy: o.proxy,
  });
  const r = spawnSync(argv[0]!, argv.slice(1), {
    cwd: p.checkout,
    env: sandboxEnv(p.home, null, {}),
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
