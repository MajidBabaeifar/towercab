// The sandbox of the repo's commands (PIP-23 **Sandbox**, PIP-157..159) and the repo's shared build cache
// (LOOP-34): setup, checks and screenshots run under `bwrap` with `/` read-only, an empty HOME, /tmp and
// /run, the toolchain read-only with credential files masked, the cache, and only the checkout writable
// (its `.git` read-only). Every setting here is a constant or built from the mission; no config key, repo
// file or intent reaches it, and there is no way to switch it off.

import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RepoConfig } from "../config.ts";

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

/** The built-in package-registry list every sandboxed command and Claude run may reach (AUT-14, AUT-26). */
export const DEFAULT_NETWORK: readonly string[] = [
  "registry.npmjs.org",
  "*.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "*.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
  "github.com",
  "*.github.com",
  "*.githubusercontent.com",
  "docs.rs",
  "nodejs.org",
  "developer.mozilla.org",
];

/**
 * The toolchain directories bound read-only (PIP-157), derived in code: `~/.local/bin`, and the directory of
 * the Node that runs Towercab when it lives under HOME (which the empty HOME would otherwise hide).
 */
export function toolchainDirs(home: string, node = dirname(process.execPath)): string[] {
  return [join(home, ".local", "bin"), ...(node.startsWith(`${home}/`) ? [node] : [])];
}

/**
 * What `toolchainDirs` needs mounted (PIP-157): Node's whole install when its `bin` sits in its own directory
 * under HOME, since `npm` and `npx` there are links into `../lib`; the directories themselves otherwise.
 */
export function toolchainMounts(home: string, node = dirname(process.execPath)): string[] {
  const shared = new Set([home, join(home, ".local")]);
  const mounts = toolchainDirs(home, node).map((d) => {
    const root = dirname(d);
    return basename(d) === "bin" && root.startsWith(`${home}/`) && !shared.has(root) ? root : d;
  });
  return [...new Set(mounts)];
}

/** `PATH` of every sandboxed command and Claude run (PIP-157): the toolchain, then the system's. */
export function sandboxPath(home: string): string {
  return [
    ...toolchainDirs(home),
    "/usr/local/sbin",
    "/usr/local/bin",
    "/usr/sbin",
    "/usr/bin",
    "/sbin",
    "/bin",
  ]
    .filter((d, i, all) => all.indexOf(d) === i)
    .join(":");
}

/** Where the proxy's pieces are bound inside the sandbox, and the port its bridge listens on. */
export const PROXY_DIR = "/run/tc";
export const PROXY_PORT = 3128;
const BRIDGE = fileURLToPath(new URL("./proxy-bridge.ts", import.meta.url));

export interface SandboxOpts {
  checkout: string;
  /** The user's HOME: an empty tmpfs inside. */
  home: string;
  /** `<home>/cache/<repo>`, or null for none. */
  cache: string | null;
  cacheWritable: boolean;
  line: string;
  /** The proxy's unix socket (`proxySocket`), or null: nothing is reachable. */
  proxy?: string | null;
  /** The bwrap executable (default `bwrap`, found on the child's PATH). */
  bwrap?: string;
}

/**
 * `bwrap --unshare-net --unshare-pid --unshare-ipc --unshare-uts --new-session --die-with-parent
 * --ro-bind / / --dev /dev --proc /proc --tmpfs /run [proxy binds] --tmpfs <HOME> --tmpfs /tmp
 * {--ro-bind <d> <d>, --ro-bind /dev/null <d>/<masked>} [--bind|--ro-bind <cache>] --bind <checkout>
 * <checkout> --ro-bind-try <checkout>/.git <same> --chdir <checkout> -- [bridge] sh -c <line>`. The network
 * is always unshared; with a proxy the bridge listens on 127.0.0.1 inside and sets the proxy variables.
 */
export function sandboxArgv(o: SandboxOpts): string[] {
  const a = [o.bwrap ?? "bwrap", "--unshare-net"];
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
  if (o.proxy) {
    a.push(
      "--ro-bind",
      process.execPath,
      `${PROXY_DIR}/node`,
      "--ro-bind",
      BRIDGE,
      `${PROXY_DIR}/bridge.ts`,
      "--bind",
      o.proxy,
      `${PROXY_DIR}/proxy.sock`,
    );
  }
  a.push("--tmpfs", o.home, "--tmpfs", "/tmp");
  for (const d of toolchainMounts(o.home).filter((d) => existsSync(d))) {
    a.push("--ro-bind", d, d);
    for (const f of MASKED.map((f) => join(d, f)).filter((f) => existsSync(f)))
      a.push("--ro-bind", "/dev/null", f);
  }
  if (o.cache) a.push(o.cacheWritable ? "--bind" : "--ro-bind", o.cache, o.cache);
  const git = join(o.checkout, ".git");
  a.push("--bind", o.checkout, o.checkout, "--ro-bind-try", git, git, "--chdir", o.checkout);
  a.push("--", "sh", "-c", o.proxy ? withProxy(o.line) : o.line);
  return a;
}

/**
 * The line with the proxy in front of it: starts the bridge (waiting until it listens), points the usual
 * proxy variables at it, then runs `line`. Without the bound pieces it does nothing, and the command has no
 * network, so a missing bridge fails closed.
 */
export function withProxy(line: string): string {
  const url = `http://127.0.0.1:${PROXY_PORT}`;
  const vars = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
  return [
    `if [ -x ${PROXY_DIR}/node ]; then`,
    `  ${PROXY_DIR}/node ${PROXY_DIR}/bridge.ts ${PROXY_DIR}/proxy.sock ${PROXY_PORT} ${PROXY_DIR}/ready &`,
    `  i=0; while [ ! -e ${PROXY_DIR}/ready ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done`,
    `  export ${vars.map((v) => `${v}=${url}`).join(" ")}`,
    "fi",
    line,
  ].join("\n");
}

const TOKEN_NAME = /TOKEN|KEY|SECRET|PASSWORD|AUTH/i;
const FIXED_NAME = /^(PATH|HOME|LANG|TMPDIR|SHELL|USER|LOGNAME|(http|https|all|no)_proxy)$/i;
const SECRET_VALUE = [
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /glpat-[A-Za-z0-9_-]{16,}/,
  /sk-ant-[A-Za-z0-9_-]{10,}/,
  /\bsk-[A-Za-z0-9]{20,}/,
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/,
  /xox[abprs]-[A-Za-z0-9-]{10,}/,
  /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /AGE-SECRET-KEY-/,
];

/** Why a repo variable may not reach the sandbox (PIP-159), or null when it may. */
export function envRefusal(name: string, value: string): string | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return "the name is not a valid variable name";
  if (TOKEN_NAME.test(name)) return "the name looks like a token, key, secret, password or login";
  if (FIXED_NAME.test(name) || /^(LD_|SOPS_|AGE_)/i.test(name))
    return "the sandbox sets or protects this variable";
  if (SECRET_VALUE.some((p) => p.test(value))) return "the value looks like a secret";
  return null;
}

/** A repo's `[repos.<r>].env` without the variables `envRefusal` refuses. */
export function allowedRepoEnv(env: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(env ?? {}).filter(([k, v]) => envRefusal(k, v) === null));
}

/** The variables of `env` that `envRefusal` refuses, with the reason (named by `towercab doctor`). */
export function refusedRepoEnv(env: Record<string, string> | undefined): { name: string; why: string }[] {
  return Object.entries(env ?? {}).flatMap(([name, v]) => {
    const why = envRefusal(name, v);
    return why ? [{ name, why }] : [];
  });
}

/** The cache's variables (LOOP-34), then the repo's own variables that pass the rule of PIP-159. */
export function cacheEnv(cache: string, repo: RepoConfig | null): Record<string, string> {
  return {
    XDG_CACHE_HOME: join(cache, "xdg"),
    npm_config_cache: join(cache, "npm"),
    CARGO_HOME: join(cache, "cargo"),
    CARGO_TARGET_DIR: join(cache, "target"),
    GOCACHE: join(cache, "go"),
    PIP_CACHE_DIR: join(cache, "pip"),
    ...allowedRepoEnv(repo?.env),
  };
}

/** SHIP-36: only Towercab's own process holds the age key; no worker or check gets it. */
export function withoutAgeKey(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/^(SOPS_|AGE_)/i.test(k)));
}

/**
 * A sandboxed command's whole environment (PIP-159): HOME, PATH, LANG, TMPDIR, then `cache` (`cacheEnv`).
 * Nothing of Towercab's own environment passes. `config` is not read: no setting reaches the sandbox.
 */
export function sandboxEnv(
  home: string,
  _config: unknown,
  cache: Record<string, string>,
): Record<string, string> {
  return withoutAgeKey({
    ...cache,
    HOME: home,
    PATH: sandboxPath(home),
    LANG: process.env.LANG || "C.UTF-8",
    TMPDIR: "/tmp",
  });
}
