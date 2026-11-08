// The sandbox of the repo's commands (PIP-23 **Sandbox**, PIP-157..159) and the repo's shared build cache
// (LOOP-34): setup, checks and screenshots run under `bwrap` with `/` read-only, an empty HOME, /tmp and
// /run, the toolchain read-only with credential files masked, the cache, and only the checkout writable
// (its `.git` read-only). Every setting here is a constant or built from the mission; no config key, repo
// file or intent reaches it, and there is no way to switch it off.

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
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

/** The usual install places of toolchains under HOME (PIP-223), fixed in code; `zig-*` is read from `~/.local`. */
const TOOLCHAIN_PLACES = [".cargo/bin", ".rustup", ".local/go", ".local/node"];

/** True when `dir` is a directory that really lies inside HOME (a symlink leaving HOME is not one). */
function insideHome(home: string, dir: string): boolean {
  try {
    const real = realpathSync(dir);
    const root = realpathSync(home);
    return statSync(real).isDirectory() && real.startsWith(`${root}/`);
  } catch {
    return false;
  }
}

/** `~/.local/zig-*` directories that exist, the newest (by name) first (PIP-223). */
function zigDirs(home: string): string[] {
  const local = join(home, ".local");
  try {
    return readdirSync(local)
      .filter((n) => n.startsWith("zig-"))
      .sort((a, b) => b.localeCompare(a, "en", { numeric: true }))
      .map((n) => join(local, n))
      .filter((d) => insideHome(home, d));
  } catch {
    return [];
  }
}

/** The existing masked files (`MASKED`) at the top of `dir` and one level below it (PIP-224). */
function maskedIn(dir: string): string[] {
  let subs: string[] = [];
  try {
    subs = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(dir, e.name));
  } catch {
    // Unreadable: only the top level is masked.
  }
  return [dir, ...subs].flatMap((d) => MASKED.map((f) => join(d, f)).filter((f) => existsSync(f)));
}

/** The standard toolchain locations under HOME that exist, in the order of PIP-223 (the `.rustup` has no bin). */
export function toolchainPlaces(home: string): string[] {
  const found = (rels: string[]) => rels.map((r) => join(home, r)).filter((d) => insideHome(home, d));
  return [...found(TOOLCHAIN_PLACES.slice(0, 3)), ...zigDirs(home), ...found(TOOLCHAIN_PLACES.slice(3))];
}

/** The directory of the Node that runs Towercab when it lives under HOME (the empty HOME would hide it). */
function ownNode(home: string, node = dirname(process.execPath)): string[] {
  return node.startsWith(`${home}/`) ? [node] : [];
}

/**
 * The toolchain directories bound read-only (PIP-157, PIP-223), derived in code: the standard locations that
 * exist, `~/.local/bin`, and the directory of the Node that runs Towercab when it lives under HOME.
 */
export function toolchainDirs(home: string, node = dirname(process.execPath)): string[] {
  return [...new Set([...toolchainPlaces(home), join(home, ".local", "bin"), ...ownNode(home, node)])];
}

/** The `bin` directories of the bound toolchains, in the fixed order of PIP-223, then `~/.local/bin`. */
export function toolchainBins(home: string): string[] {
  const bin = (d: string) => {
    const rel = d.slice(home.length + 1);
    if (rel === ".rustup") return [];
    if (rel === ".local/go" || rel === ".local/node") return [join(d, "bin")];
    return [d];
  };
  return [...new Set([...toolchainPlaces(home).flatMap(bin), join(home, ".local", "bin"), ...ownNode(home)])];
}

/**
 * What `toolchainDirs` needs mounted (PIP-157): Node's whole install when its `bin` sits in its own directory
 * under HOME, since `npm` and `npx` there are links into `../lib`; the directories themselves otherwise.
 */
export function toolchainMounts(home: string, node = dirname(process.execPath)): string[] {
  const shared = new Set([home, join(home, ".local")]);
  // Only `~/.local/bin` and Node's own directory widen; `~/.cargo/bin` stays alone so the rest of `~/.cargo` is not bound (PIP-224).
  const widen = (d: string) => {
    const root = dirname(d);
    return basename(d) === "bin" && root.startsWith(`${home}/`) && !shared.has(root) ? root : d;
  };
  const rest = toolchainDirs(home, node).filter((d) => !toolchainPlaces(home).includes(d));
  return [...new Set([...toolchainPlaces(home), ...rest.map(widen)])];
}

/** `PATH` of every sandboxed command and Claude run (PIP-157): the toolchain, then the system's. */
export function sandboxPath(home: string): string {
  return [
    ...toolchainBins(home),
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
    for (const f of maskedIn(d)) a.push("--ro-bind", "/dev/null", f);
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
export function cacheEnv(
  cache: string,
  repo: RepoConfig | null,
  home: string = homedir(),
): Record<string, string> {
  const rustup = toolchainPlaces(home).find((d) => d === join(home, ".rustup"));
  return {
    XDG_CACHE_HOME: join(cache, "xdg"),
    npm_config_cache: join(cache, "npm"),
    CARGO_HOME: join(cache, "cargo"),
    CARGO_TARGET_DIR: join(cache, "target"),
    GOCACHE: join(cache, "go"),
    PIP_CACHE_DIR: join(cache, "pip"),
    ...allowedRepoEnv(repo?.env),
    // PIP-225: the Go and Zig caches and the bound rustup are fixed; a repo's variable of the same name loses.
    GOPATH: join(cache, "go", "path"),
    GOMODCACHE: join(cache, "go", "path", "pkg", "mod"),
    ZIG_GLOBAL_CACHE_DIR: join(cache, "zig", "global"),
    ZIG_LOCAL_CACHE_DIR: join(cache, "zig", "local"),
    ...(rustup ? { RUSTUP_HOME: rustup } : {}),
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
