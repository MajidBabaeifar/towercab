// The sandbox of the repo's commands (PIP-23 **Sandbox**) and the repo's shared build cache
// (LOOP-34): setup, checks and screenshots run under `bwrap` with `/` read-only, an empty HOME,
// /tmp and /run, the toolchain read-only with credential files masked, the cache, and only the
// checkout writable (its `.git` read-only).

import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Config, RepoConfig } from "../config.ts";

/** Files masked (`--ro-bind /dev/null <dir>/<name>`) in each toolchain directory that has them. */
export const MASKED = [
  "credentials",
  "credentials.toml",
  ".credentials.json",
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "auth.json",
  "hosts.yml",
];

export interface SandboxOpts {
  checkout: string;
  /** The user's HOME: an empty tmpfs inside. */
  home: string;
  /** `[agent].toolchain`: bound read-only when they exist. */
  toolchain: string[];
  /** `<home>/cache/<repo>`, or null for none. */
  cache: string | null;
  network: boolean;
  cacheWritable: boolean;
  line: string;
  /** The bwrap executable (default `bwrap`, found on the child's PATH). */
  bwrap?: string;
  /** Where `/etc/resolv.conf` points, when that is under /run (default: looked up). */
  resolv?: string | null;
}

/**
 * `bwrap [--unshare-net] --unshare-pid --unshare-ipc --unshare-uts --new-session --die-with-parent
 * --ro-bind / / --dev /dev --proc /proc --tmpfs /run [--ro-bind-try <resolv.conf>] --tmpfs <HOME>
 * --tmpfs /tmp {--ro-bind <d> <d>, --ro-bind /dev/null <d>/<masked>} [--bind|--ro-bind <cache>]
 * --bind <checkout> <checkout> --ro-bind-try <checkout>/.git <same> --chdir <checkout> -- sh -c
 * <line>`. `--dev /dev`: the read-only `/` is `nodev`; resolv.conf is bound back only with network.
 */
export function sandboxArgv(o: SandboxOpts): string[] {
  const a = [o.bwrap ?? "bwrap"];
  if (!o.network) a.push("--unshare-net");
  a.push(
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--new-session",
    "--die-with-parent",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/run",
  );
  const resolv = o.resolv === undefined ? resolvConf() : o.resolv;
  if (o.network && resolv) a.push("--ro-bind-try", resolv, resolv);
  a.push("--tmpfs", o.home, "--tmpfs", "/tmp");
  for (const d of o.toolchain.filter((d) => existsSync(d))) {
    a.push("--ro-bind", d, d);
    for (const f of MASKED.map((f) => join(d, f)).filter((f) => existsSync(f)))
      a.push("--ro-bind", "/dev/null", f);
  }
  if (o.cache) a.push(o.cacheWritable ? "--bind" : "--ro-bind", o.cache, o.cache);
  const git = join(o.checkout, ".git");
  a.push("--bind", o.checkout, o.checkout, "--ro-bind-try", git, git, "--chdir", o.checkout);
  a.push("--", "sh", "-c", o.line);
  return a;
}

/** `/etc/resolv.conf`'s target when it is under /run (systemd-resolved), else null. */
export function resolvConf(): string | null {
  try {
    const p = realpathSync("/etc/resolv.conf");
    return p.startsWith("/run/") ? p : null;
  } catch {
    return null;
  }
}

/**
 * The env of setup, the worker and checks of a repo (LOOP-34): the cache's variables under `cache`,
 * then `[agent].env`, then `[repos.<r>].env` (later wins).
 */
export function cacheEnv(cache: string, config: Config, repo: RepoConfig | null): Record<string, string> {
  return {
    XDG_CACHE_HOME: join(cache, "xdg"),
    npm_config_cache: join(cache, "npm"),
    CARGO_HOME: join(cache, "cargo"),
    CARGO_TARGET_DIR: join(cache, "target"),
    GOCACHE: join(cache, "go"),
    PIP_CACHE_DIR: join(cache, "pip"),
    ...config.agent.env,
    ...(repo?.env ?? {}),
  };
}

/** A sandboxed command's whole environment: HOME, PATH = `[agent].path`, LANG, TMPDIR, then `cacheEnv`. */
export function sandboxEnv(
  home: string,
  config: Config,
  cache: Record<string, string>,
): Record<string, string> {
  return {
    HOME: home,
    PATH: config.agent.path,
    LANG: process.env.LANG || "C.UTF-8",
    TMPDIR: "/tmp",
    ...cache,
  };
}
