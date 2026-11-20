// A repo's setup-only secrets (PIP-211..214): `<config dir>/setup-secrets/<repo>.env`, private to the owner,
// set only in the environment of the first setup pass, hidden from every log in all their encodings, and
// searched for in what that pass left behind. This file holds the parts that need no mission.

import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { assertPrivate, REDACTED } from "../ship/secrets.ts";
import { sandboxPath } from "./sandbox.ts";

/** A setup secrets file that can't be used; the stage waits on `fix repo files` with the message. */
export class SetupSecretsError extends Error {}

export const MIN_TOKEN = 8;
/** Cache files changed during setup are searched up to this size (PIP-212). */
export const MAX_CACHE_SCAN = 256 * 1024;

export function setupSecretsPath(configFile: string, repo: string): string {
  return join(dirname(configFile), "setup-secrets", `${repo}.env`);
}

export function hasSetupSecrets(configFile: string, repo: string): boolean {
  return existsSync(setupSecretsPath(configFile, repo));
}

export interface SetupSecrets {
  /** Every line of the file, as the setup environment gets it. */
  env: Record<string, string>;
  /** The tokens: every line that is not the username of another. */
  tokens: { key: string; value: string }[];
  /** A token with its declared `<KEY>_USERNAME`. */
  pairs: { key: string; user: string; token: string }[];
}

/** Variables Towercab sets itself in the secret pass, or protects (PIP-159, LOOP-34); a secret can't be one. */
const OWN_KEYS =
  /^(PATH|HOME|LANG|TMPDIR|SHELL|USER|LOGNAME|(http|https|all|no)_proxy|LD_.*|SOPS_.*|AGE_.*|XDG_CACHE_HOME|XDG_CONFIG_HOME|npm_config_cache|npm_config_ignore_scripts|NPM_CONFIG_USERCONFIG|PIP_CONFIG_FILE|PIP_CACHE_DIR|PIP_ONLY_BINARY|POETRY_CONFIG_DIR|YARN_ENABLE_SCRIPTS|UV_NO_BUILD|CARGO_HOME|CARGO_TARGET_DIR|GOCACHE|GOPATH|GOMODCACHE|ZIG_GLOBAL_CACHE_DIR|ZIG_LOCAL_CACHE_DIR|RUSTUP_HOME)$/i;

/** Reads the file; none → null. A bad file → `SetupSecretsError` (never quoting a value). */
export function readSetupSecrets(path: string): SetupSecrets | null {
  if (!existsSync(path)) return null;
  try {
    assertPrivate(path);
  } catch (e) {
    throw new SetupSecretsError((e as Error).message);
  }
  const env: Record<string, string> = {};
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const [i, raw] of lines.entries()) {
    const l = raw.trim();
    if (!l || l.startsWith("#")) continue;
    const eq = l.indexOf("=");
    const key = eq > 0 ? l.slice(0, eq).trim() : "";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      throw new SetupSecretsError(`${path} line ${i + 1} is not KEY=VALUE`);
    if (OWN_KEYS.test(key))
      throw new SetupSecretsError(
        `${path} line ${i + 1}: ${key} is set by Towercab and cannot be a setup secret`,
      );
    env[key] = l.slice(eq + 1).trim();
  }
  const users = (k: string) => k.endsWith("_USERNAME") && k.slice(0, -"_USERNAME".length) in env;
  const tokens: SetupSecrets["tokens"] = [];
  const pairs: SetupSecrets["pairs"] = [];
  for (const [key, value] of Object.entries(env)) {
    if (users(key)) continue;
    if (/:\/\/|\s|["']/.test(value)) throw new SetupSecretsError(`${path}: ${key} must hold the token only`);
    if (value.length < MIN_TOKEN) throw new SetupSecretsError(`${path}: ${key} is shorter than 8 characters`);
    tokens.push({ key, value });
    const user = env[`${key}_USERNAME`];
    if (user) pairs.push({ key, user, token: value });
  }
  return { env, tokens, pairs };
}

const b64 = (s: string) => Buffer.from(s).toString("base64");

/** Base64 of `text` in the standard and URL-safe alphabets, as it can sit inside a longer base64 string. */
function base64Forms(text: string): string[] {
  const out: string[] = [];
  for (const [shift, skip] of [
    [0, 0],
    [1, 2],
    [2, 3],
  ] as const) {
    const full = b64(" ".repeat(shift) + text);
    const bare = full.replace(/=+$/, "");
    const bytes = shift + Buffer.byteLength(text);
    // The last character of a partial group depends on the bytes after it.
    const body = bytes % 3 === 0 ? bare : bare.slice(0, -1);
    out.push(body.slice(skip));
    if (shift === 0) out.push(full, bare);
  }
  return out.flatMap((f) => [f, f.replace(/\+/g, "-").replace(/\//g, "_")]);
}

/** Every form of `token` that is hidden: raw, percent-encoded (both cases of hex), base64 (PIP-213). */
export function tokenForms(token: string): string[] {
  const pct = encodeURIComponent(token);
  return [token, pct, pct.replace(/%[0-9A-F]{2}/g, (h) => h.toLowerCase()), ...base64Forms(token)];
}

/** The forms to hide, longest first, each with the key it came from. */
export function secretForms(s: SetupSecrets): { form: string; key: string }[] {
  const seen = new Map<string, string>();
  const add = (form: string, key: string) => {
    if (form.length >= 6 && !seen.has(form)) seen.set(form, key);
  };
  for (const t of s.tokens) for (const f of tokenForms(t.value)) add(f, t.key);
  // The Basic-auth value built from `<username>:<token>`, bare and in its header.
  for (const p of s.pairs) for (const f of base64Forms(`${p.user}:${p.token}`)) add(f, p.key);
  return [...seen].map(([form, key]) => ({ form, key })).sort((a, b) => b.form.length - a.form.length);
}

/** The text with every form of every setup token replaced by `[redacted]`. */
export function redactSetup(s: SetupSecrets, text: string): string {
  let out = text;
  for (const { form } of secretForms(s)) out = out.split(form).join(REDACTED);
  return out;
}

/** The first form found in the file, by streaming it in overlapping chunks, or null. */
function findInFile(path: string, forms: { form: string; key: string }[]): string | null {
  const needles = forms.map((f) => ({ ...f, buf: Buffer.from(f.form) }));
  const keep = Math.max(...needles.map((n) => n.buf.length)) - 1;
  const CHUNK = 1024 * 1024;
  const fd = openSync(path, "r");
  try {
    let tail: Buffer = Buffer.alloc(0);
    const buf = Buffer.alloc(CHUNK);
    for (;;) {
      const n = readSync(fd, buf, 0, CHUNK, null);
      if (n === 0) return null;
      const window = Buffer.concat([tail, buf.subarray(0, n)]);
      for (const nd of needles) if (window.includes(nd.buf)) return nd.key;
      tail = window.subarray(Math.max(0, window.length - keep));
    }
  } finally {
    closeSync(fd);
  }
}

export interface Hit {
  /** Where, relative to what was searched (`<label>/<path>`), never the line. */
  path: string;
  key: string;
}

/**
 * Searches the regular files under `root` (links are not followed) for any form; `skip` names directories to
 * leave out, `want` filters files by size and mtime. The first hit, or null.
 */
export function scanDir(
  root: string,
  label: string,
  s: SetupSecrets,
  o: { skip?: string[]; want?: (size: number, mtimeMs: number) => boolean } = {},
): Hit | null {
  const forms = secretForms(s);
  if (!forms.length || !existsSync(root)) return null;
  const walk = (dir: string): Hit | null => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (o.skip?.includes(relative(root, p))) continue;
        const h = walk(p);
        if (h) return h;
      } else if (e.isFile()) {
        const st = lstatSync(p);
        if (o.want && !o.want(st.size, st.mtimeMs)) continue;
        const key = findInFile(p, forms);
        if (key) return { path: join(label, relative(root, p)), key };
      }
    }
    return null;
  };
  return walk(root);
}

/** The small git files of a checkout (PIP-212): config files, hooks and info; never objects or packs. */
export function scanGitFiles(checkout: string, s: SetupSecrets): Hit | null {
  const forms = secretForms(s);
  const git = join(checkout, ".git");
  const files = ["config", "config.worktree"].map((f) => join(git, f));
  for (const dir of ["info", "hooks"]) {
    try {
      files.push(...readdirSync(join(git, dir)).map((f) => join(git, dir, f)));
    } catch {
      // No such folder.
    }
  }
  try {
    for (const m of readdirSync(join(git, "modules"))) files.push(join(git, "modules", m, "config"));
  } catch {
    // No submodules.
  }
  for (const f of files) {
    if (!existsSync(f) || !lstatSync(f).isFile()) continue;
    const key = findInFile(f, forms);
    if (key) return { path: join(".git", relative(git, f)), key };
  }
  return null;
}

/** The files of `changed` that are a package manifest or lockfile, at any depth (PIP-214). */
const MANIFEST =
  /^(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|\.yarnrc\.yml|\.npmrc|requirements.*\.txt|constraints.*\.txt|pyproject\.toml|poetry\.lock|uv\.lock|Pipfile|Pipfile\.lock|pip\.conf|setup\.py|setup\.cfg)$/;

export function manifestChanges(changed: string[]): string[] {
  return changed.filter((f) => MANIFEST.test(basename(f)));
}

/** Tools whose install or build code can't be switched off (PIP-214): the first one a setup line runs, or null. */
const NO_SWITCH = ["cargo", "go", "bundle", "gem", "make", "mvn", "gradle"];

export function unsupportedTool(lines: string[]): string | null {
  for (const line of lines) {
    for (const part of line.split(/[;&|\n(){}'"`]+/)) {
      const words = part.trim().split(/\s+/);
      while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words.shift();
      const cmd = basename(words[0] ?? "");
      if (NO_SWITCH.includes(cmd)) return cmd;
    }
  }
  return null;
}

/** A pass-2 log that shows a registry refused or didn't know a package (PIP-214). */
export function needsPrivate(log: string): boolean {
  return /\b40[134]\b|E40[134]|Unauthorized|Forbidden|not in this registry/i.test(log);
}

/** The first registry host a refusal in the log names, or null. */
export function refusedHost(log: string): string | null {
  for (const l of log.split("\n")) {
    if (!/\b40[134]\b|E40[134]|Unauthorized|Forbidden/i.test(l)) continue;
    const m = /https?:\/\/([A-Za-z0-9.-]+)/.exec(l);
    if (m) return m[1]!;
  }
  return null;
}

/** The variables that switch install scripts and source builds off (PIP-214). */
export const SCRIPTS_OFF: Record<string, string> = {
  npm_config_ignore_scripts: "true",
  YARN_ENABLE_SCRIPTS: "false",
  PIP_ONLY_BINARY: ":all:",
  UV_NO_BUILD: "1",
};

/** Where setup is told to keep registry credentials (PIP-212), inside the credentials folder `creds`. */
export function credsEnv(creds: string): Record<string, string> {
  return {
    NPM_CONFIG_USERCONFIG: join(creds, "npmrc"),
    PIP_CONFIG_FILE: join(creds, "pip.conf"),
    XDG_CONFIG_HOME: join(creds, "xdg"),
    POETRY_CONFIG_DIR: join(creds, "poetry"),
  };
}

/** `PATH` of the secret pass: the sandbox's fixed list without `~/.local/bin`, relative entries or the checkout's. */
export function systemPath(home: string, ...inside: string[]): string {
  return sandboxPath(home)
    .split(":")
    .filter(
      (d) =>
        d.startsWith("/") &&
        d !== join(home, ".local", "bin") &&
        !inside.some((i) => d === i || d.startsWith(`${i}/`)),
    )
    .join(":");
}
