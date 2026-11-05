// Config (LOOP-1, **Config**): ~/.config/towercab/config.toml, validated with errors that name the key.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";

export const DEFAULT_NETWORK = [
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

export interface RepoConfig {
  name: string;
  github: string;
  path: string;
  base: string;
  workers: number;
  /** Intents that may be ahead of build at once (LOOP-60). */
  ahead: number;
  env: Record<string, string>;
}

export interface Config {
  file: string;
  intents: { remote: string; path: string | null; cutoff: number; issueA: number };
  agent: {
    model: string;
    reviewModel: string | null;
    parallel: number;
    buildTimeoutMin: number;
    reviewTimeoutMin: number;
    checkTimeoutMin: number;
    maxBudgetUsd: number;
    dailyBudgetUsd: number | null;
    ciPoll: number;
    ciGrace: number;
    ciWait: number;
    path: string;
    toolchain: string[];
    env: Record<string, string>;
    network: string[];
    sandboxUnixSockets: boolean;
  };
  /**
   * The repos Towercab works on. Filled from the file by `parseConfig`, then from the database by
   * `loadRepos` (LOOP-65); the same Map all along, so a repo added at runtime is seen everywhere.
   */
  repos: Map<string, RepoConfig>;
  /** The file's valid `[repos.<name>]` tables, imported into the database once (LOOP-65). */
  fileRepos: Map<string, RepoConfig>;
  /** Repo tables that failed to validate: name → reason. They fail only what uses that repo. */
  badRepos: Map<string, string>;
  /** Repo tables Towercab ignores because the repo is in its database: name → what to do (LOOP-65). */
  ignoredRepos: Map<string, string>;
  github: { appId: number; me: string; apiBase: string } | null;
  telegram: { botToken: string; chatId: string; apiBase: string } | null;
  ui: { port: number };
  /** `drainMinutes`: how long a drain for an update waits before cutting runs off (LOOP-109). */
  update: { auto: boolean; drainMinutes: number };
}

export class ConfigError extends Error {}

/** `--config` > `TOWERCAB_CONFIG` > `~/.config/towercab/config.toml`. */
export function configPath(flag?: string): string {
  return expand(flag ?? process.env.TOWERCAB_CONFIG ?? "~/.config/towercab/config.toml");
}

export function expand(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function loadConfig(file: string): Config {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    throw new ConfigError(
      `config: ${file}: ${(e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : String(e)}`,
    );
  }
  let raw: Record<string, unknown>;
  try {
    raw = parseToml(text) as Record<string, unknown>;
  } catch (e) {
    throw new ConfigError(`config: ${file}: ${(e as Error).message.split("\n")[0]}`);
  }
  return parseConfig(raw, file);
}

export function parseConfig(raw: Record<string, unknown>, file: string): Config {
  const r = new Reader(file);
  const intents = r.table(raw.intents ?? raw.tasks, "intents");
  const agent = r.table(raw.agent, "agent");
  const github = raw.github === undefined ? null : r.table(raw.github, "github");
  const telegram = raw.telegram === undefined ? null : r.table(raw.telegram, "telegram");
  const ui = r.table(raw.ui, "ui");
  const update = r.table(raw.update, "update");

  const config: Config = {
    file,
    intents: {
      remote: r.str(intents, "intents", "remote", ""),
      path: r.optPath(intents, "intents", "path"),
      cutoff: r.int(intents, "intents", "cutoff", 7, 1, 15),
      issueA: r.int(intents, "intents", "issue_a", 3, 1, 5),
    },
    agent: {
      model: r.word(agent, "agent", "model", "opus"),
      reviewModel: r.optWord(agent, "agent", "review_model"),
      parallel: r.int(agent, "agent", "parallel", 1, 1, 16),
      buildTimeoutMin: r.int(agent, "agent", "build_timeout", 60, 1, 1440),
      reviewTimeoutMin: r.int(agent, "agent", "review_timeout", 15, 1, 1440),
      checkTimeoutMin: r.int(agent, "agent", "check_timeout", 10, 1, 1440),
      maxBudgetUsd: r.num(agent, "agent", "max_budget_usd", 10, 0, 1000),
      dailyBudgetUsd: r.optNum(agent, "agent", "daily_budget_usd", 0, 100000),
      ciPoll: r.int(agent, "agent", "ci_poll", 30, 5, 3600),
      ciGrace: r.int(agent, "agent", "ci_grace", 120, 0, 3600),
      ciWait: r.int(agent, "agent", "ci_wait", 1800, 60, 86400),
      path: r.str(agent, "agent", "path", process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"),
      toolchain: r.dirs(agent, "agent", "toolchain", ["~/.local/bin"]),
      env: r.env(agent, "agent", "env"),
      network: r.strList(agent, "agent", "network", DEFAULT_NETWORK),
      sandboxUnixSockets: r.bool(agent, "agent", "sandbox_unix_sockets", false),
    },
    repos: new Map(),
    fileRepos: new Map(),
    badRepos: new Map(),
    ignoredRepos: new Map(),
    github: github && {
      appId: r.int(github, "github", "app_id", 0, 1, Number.MAX_SAFE_INTEGER),
      me: r.login(github, "github", "me"),
      apiBase: r.url(github, "github", "api_base", "https://api.github.com"),
    },
    telegram: telegram && {
      botToken: r.str(telegram, "telegram", "bot_token", ""),
      chatId: String(telegram.chat_id ?? ""),
      apiBase: r.url(telegram, "telegram", "api_base", "https://api.telegram.org"),
    },
    ui: { port: r.int(ui, "ui", "port", 7311, 0, 65535) },
    update: {
      auto: r.bool(update, "update", "auto", true),
      drainMinutes: r.int(update, "update", "drain_minutes", 60, 1, 1440),
    },
  };
  if (config.telegram && (!config.telegram.botToken || !config.telegram.chatId)) {
    throw new ConfigError(`config: ${file}: telegram.bot_token and telegram.chat_id are required`);
  }

  const repos = raw.repos;
  if (repos !== undefined && (typeof repos !== "object" || repos === null || Array.isArray(repos))) {
    throw new ConfigError(`config: ${file}: repos must be a table`);
  }
  for (const [name, table] of Object.entries((repos ?? {}) as Record<string, unknown>)) {
    try {
      const repo = parseRepo(r, name, table);
      config.fileRepos.set(name, repo);
      config.repos.set(name, repo);
    } catch (e) {
      config.badRepos.set(name, (e as Error).message);
    }
  }
  return config;
}

function parseRepo(r: Reader, name: string, raw: unknown): RepoConfig {
  const key = `repos.${name}`;
  if (!isRepoName(name) || name === "intents") throw r.err(`${key}: bad repo name`);
  const t = r.table(raw, key);
  const github = r.str(t, key, "github", "");
  if (!github) throw r.err(`${key}.github is required`);
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(github)) throw r.err(`${key}.github must be owner/name`);
  const base = r.str(t, key, "base", "main");
  if (!isBranch(base)) throw r.err(`${key}.base is not a branch name`);
  return {
    name,
    github,
    path: r.optPath(t, key, "path") ?? "",
    base,
    workers: r.int(t, key, "workers", 1, 1, 16),
    ahead: r.int(t, key, "ahead", 3, 1, 16),
    env: r.env(t, key, "env"),
  };
}

/** `[A-Za-z0-9._-]+`, not starting with `-`, not `.` or `..` (INT-2). */
export function isRepoName(s: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(s) && !s.startsWith("-") && s !== "." && s !== "..";
}

export function isBranch(s: string): boolean {
  return (
    /^[A-Za-z0-9._/-]+$/.test(s) &&
    s !== "HEAD" &&
    !s.startsWith("-") &&
    !s.endsWith(".") &&
    !s.includes("..") &&
    s.split("/").every((c) => c !== "" && !c.startsWith(".") && !c.endsWith(".lock"))
  );
}

/** The repo's clone: its `path`, else `<home>/repos/<name>`. */
export function clonePath(repo: RepoConfig, home: string): string {
  return repo.path || join(home, "repos", repo.name);
}

/** What `run` and `up` need beyond a valid file. */
export function checkLoop(config: Config): void {
  if (!config.github) throw new ConfigError(`config: ${config.file}: [github] is required (app_id, me)`);
  if (!config.intents.remote) throw new ConfigError(`config: ${config.file}: intents.remote is required`);
  if (config.repos.size === 0) {
    const bad = [...config.badRepos.values()][0];
    throw new ConfigError(bad ?? "no repos yet: add one with towercab repo add <owner/name>");
  }
}

/** The App key: `app.pem` next to the config file. */
export function appKeyPath(config: Config): string {
  return join(dirname(resolve(config.file)), "app.pem");
}

class Reader {
  private file: string;
  constructor(file: string) {
    this.file = file;
  }

  err(what: string): ConfigError {
    return new ConfigError(`config: ${this.file}: ${what}`);
  }

  table(v: unknown, key: string): Record<string, unknown> {
    if (v === undefined) return {};
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw this.err(`${key} must be a table`);
    return v as Record<string, unknown>;
  }

  str(t: Record<string, unknown>, s: string, k: string, dflt: string): string {
    const v = t[k];
    if (v === undefined) return dflt;
    if (typeof v !== "string") throw this.err(`${s}.${k} must be a string`);
    return v;
  }

  word(t: Record<string, unknown>, s: string, k: string, dflt: string): string {
    const v = this.str(t, s, k, dflt);
    if (!v || /\s/.test(v)) throw this.err(`${s}.${k} must be a non-empty word`);
    return v;
  }

  optWord(t: Record<string, unknown>, s: string, k: string): string | null {
    return t[k] === undefined ? null : this.word(t, s, k, "");
  }

  login(t: Record<string, unknown>, s: string, k: string): string {
    const v = this.str(t, s, k, "");
    if (!/^[A-Za-z0-9-]+$/.test(v)) throw this.err(`${s}.${k} must be a GitHub login`);
    return v;
  }

  url(t: Record<string, unknown>, s: string, k: string, dflt: string): string {
    const v = this.str(t, s, k, dflt);
    if (!/^https?:\/\//.test(v)) throw this.err(`${s}.${k} must be an http(s) URL`);
    return v.replace(/\/+$/, "");
  }

  int(t: Record<string, unknown>, s: string, k: string, dflt: number, min: number, max: number): number {
    const v = t[k];
    if (v === undefined) return dflt;
    const n = typeof v === "bigint" ? Number(v) : v;
    if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
      throw this.err(`${s}.${k} must be an integer ${min}-${max}`);
    }
    return n;
  }

  num(t: Record<string, unknown>, s: string, k: string, dflt: number, min: number, max: number): number {
    return this.optNum(t, s, k, min, max) ?? dflt;
  }

  optNum(t: Record<string, unknown>, s: string, k: string, min: number, max: number): number | null {
    const v = t[k];
    if (v === undefined) return null;
    const n = typeof v === "bigint" ? Number(v) : v;
    if (typeof n !== "number" || !Number.isFinite(n) || n <= min || n > max) {
      throw this.err(`${s}.${k} must be a number above ${min}, at most ${max}`);
    }
    return n;
  }

  bool(t: Record<string, unknown>, s: string, k: string, dflt: boolean): boolean {
    const v = t[k];
    if (v === undefined) return dflt;
    if (typeof v !== "boolean") throw this.err(`${s}.${k} must be true or false`);
    return v;
  }

  strList(t: Record<string, unknown>, s: string, k: string, dflt: string[]): string[] {
    const v = t[k];
    if (v === undefined) return dflt;
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x === "")) {
      throw this.err(`${s}.${k} must be a list of non-empty strings`);
    }
    return v as string[];
  }

  dirs(t: Record<string, unknown>, s: string, k: string, dflt: string[]): string[] {
    return this.strList(t, s, k, dflt).map((d) => {
      const p = expand(d);
      if (!isAbsolute(p)) throw this.err(`${s}.${k}: ${d} is not absolute`);
      return p;
    });
  }

  optPath(t: Record<string, unknown>, s: string, k: string): string | null {
    const v = t[k];
    if (v === undefined) return null;
    if (typeof v !== "string" || v === "") throw this.err(`${s}.${k} must be a path`);
    const p = expand(v);
    if (!isAbsolute(p)) throw this.err(`${s}.${k} must be absolute or start with ~/`);
    return p;
  }

  env(t: Record<string, unknown>, s: string, k: string): Record<string, string> {
    const v = this.table(t[k], `${s}.${k}`);
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(v)) {
      if (typeof value !== "string") throw this.err(`${s}.${k}.${name} must be a string`);
      out[name] = value;
    }
    return out;
  }
}
