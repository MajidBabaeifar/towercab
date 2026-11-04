// Repos at runtime (LOOP-65..69): the `repos` table, the one-time import of config tables, and
// `repo add | remove | set | list`. `Config.repos` stays the one Map the rest of the code reads; this
// module keeps it equal to the table.

import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { ensureClone, git, originUrl } from "./checkout.ts";
import { type Config, clonePath, expand, isBranch, isRepoName, type RepoConfig } from "./config.ts";
import type { Db } from "./db.ts";
import type { GitHub } from "./handlers.ts";
import { missing, parseStored } from "./repo/readiness.ts";
import type { Tools } from "./tools.ts";

/** Where a row came from: a config table, or `repo add` from the CLI or the page. */
export type RepoSource = "config" | "cli" | "ui";

interface RepoRow {
  name: string;
  github: string;
  path: string;
  base: string;
  workers: number;
  ahead: number;
  env: string;
  source: RepoSource;
  added: number;
}

/** The meta key that marks a config table as imported: it is never imported again. */
const importedKey = (name: string) => `repo-imported:${name}`;

function toRepo(r: RepoRow): RepoConfig {
  let env: Record<string, string> = {};
  try {
    env = JSON.parse(r.env) as Record<string, string>;
  } catch {
    env = {};
  }
  return {
    name: r.name,
    github: r.github,
    path: r.path,
    base: r.base,
    workers: Number(r.workers),
    ahead: Number(r.ahead),
    env,
  };
}

/** Every repo in the database, in the order they were added. */
export function readRepos(db: Db): RepoConfig[] {
  return db.all<RepoRow>("SELECT * FROM repos ORDER BY rowid").map(toRepo);
}

function insertRepo(db: Db, repo: RepoConfig, source: RepoSource, now: number): void {
  db.run(
    "INSERT INTO repos (name, github, path, base, workers, ahead, env, source, added) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    repo.name,
    repo.github,
    repo.path,
    repo.base,
    repo.workers,
    repo.ahead,
    JSON.stringify(repo.env),
    source,
    now,
  );
}

/**
 * LOOP-68: make `config.repos` equal the table, changing only what differs, so the Map stays the
 * same object and an iteration in progress elsewhere never sees a repo twice.
 */
export function syncRepos(config: Config, db: Db): void {
  const rows = readRepos(db);
  const names = new Set(rows.map((r) => r.name));
  for (const name of [...config.repos.keys()]) if (!names.has(name)) config.repos.delete(name);
  for (const r of rows) {
    const cur = config.repos.get(r.name);
    if (!cur || JSON.stringify(cur) !== JSON.stringify(r)) config.repos.set(r.name, r);
  }
}

/** What `doctor` says of a config table that is no longer read (LOOP-65). */
const KEEP_FOR_ROLLBACK =
  "Keep it only while you might go back to a Towercab from before repos moved into the database; then delete it.";

/**
 * LOOP-65: import each valid `[repos.<name>]` table once (a name already in the database, or imported
 * before and since removed, is left alone), then fill `config.repos` from the database. Tables that
 * are now ignored land in `config.ignoredRepos` for `doctor`. Returns the names imported now.
 */
export function loadRepos(config: Config, db: Db, now: number): string[] {
  const imported: string[] = [];
  db.tx(() => {
    for (const [name, repo] of config.fileRepos) {
      if (db.meta(importedKey(name)) !== null) continue;
      db.setMeta(importedKey(name), String(Math.floor(now)));
      if (db.get("SELECT 1 FROM repos WHERE name = ?", name)) continue;
      insertRepo(db, repo, "config", now);
      imported.push(name);
    }
  });
  syncRepos(config, db);
  config.ignoredRepos.clear();
  for (const name of new Set([...config.fileRepos.keys(), ...config.badRepos.keys()])) {
    const table = `[repos.${name}] in ${config.file}`;
    if (config.repos.has(name)) {
      config.ignoredRepos.set(
        name,
        `${table} is ignored: the repo is in Towercab's database now (towercab repo list, towercab repo set). ${KEEP_FOR_ROLLBACK}`,
      );
      config.badRepos.delete(name);
    } else if (db.meta(importedKey(name)) !== null) {
      config.ignoredRepos.set(
        name,
        `${table} is ignored: the repo was removed with towercab repo remove. ${KEEP_FOR_ROLLBACK}`,
      );
    }
  }
  return imported;
}

export interface AddRepoDeps {
  db: Db;
  config: Config;
  tools: Tools;
  github: Pick<GitHub, "gh" | "gitAuth">;
  /** The home's root: the clone goes to `<home>/repos/<name>`. */
  home: string;
  now: number;
  source: RepoSource;
}

function firstLine(s: string): string {
  return (
    s
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? "no reason given"
  );
}

/** `owner/name` from what a person typed (a URL or a `.git` suffix are fine), or null. */
export function ownerName(text: string): string | null {
  const s = text
    .trim()
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  const parts = s.split("/");
  return parts.length === 2 && parts.every(isRepoName) ? s : null;
}

function duplicate(db: Db, name: string, github: string): string | null {
  const known = readRepos(db);
  const same = known.find((r) => r.name === name);
  if (same) return `${name} is already a repo (${same.github})`;
  const twin = known.find((r) => r.github.toLowerCase() === github.toLowerCase());
  if (twin) return `${github} is already added as ${twin.name}`;
  return null;
}

/** Names and repos being added in this process; a second add of the same one is refused. */
const adding = new Set<string>();

/** A repo the checks accepted; `done` settles once it is cloned and stored. */
export interface PendingAdd {
  repo: RepoConfig;
  done: Promise<RepoConfig>;
}

const failedKey = (name: string) => `repo-add-failed:${name}`;

export interface AddFailure {
  name: string;
  github: string;
  why: string;
  at: number;
}

/** UI-130: adds from the page that failed after their checks passed, newest first. */
export function addFailures(db: Db): AddFailure[] {
  return db
    .all<{ key: string; value: string }>("SELECT key, value FROM meta WHERE key LIKE 'repo-add-failed:%'")
    .map((r) => ({
      name: r.key.slice(failedKey("").length),
      ...(JSON.parse(r.value) as Omit<AddFailure, "name">),
    }))
    .sort((a, b) => b.at - a.at);
}

/**
 * LOOP-66: check that `owner/name` can be added as the repo `name` (default: the repo part): Towercab's
 * GitHub App reaches it, GitHub names it and its default branch (the `base`), and `<home>/repos/<name>`
 * is free or already a clone of it. Resolves once those pass; `done` then clones and stores it. Every
 * refusal is an Error whose message is the reason.
 */
export async function beginAddRepo(d: AddRepoDeps, text: string, name?: string): Promise<PendingAdd> {
  const typed = ownerName(text);
  if (!typed) throw new Error(`${text.trim() || "nothing"} isn't a GitHub repo: write it as owner/name`);
  const short = name?.trim() || typed.split("/")[1]!;
  if (!isRepoName(short) || short === "intents") {
    throw new Error(`${short} can't be a repo name: use letters, digits, dots, dashes and underscores`);
  }
  const keys = [`name:${short}`, `github:${typed.toLowerCase()}`];
  if (keys.some((k) => adding.has(k))) throw new Error(`${typed} is being added already`);
  const dup = duplicate(d.db, short, typed);
  if (dup) throw new Error(dup);
  for (const k of keys) adding.add(k);
  const release = () => {
    for (const k of keys) adding.delete(k);
  };
  let repo: RepoConfig;
  try {
    d.db.delMeta(failedKey(short));
    let reply: string;
    try {
      const r = await d.github.gh(typed, [
        "api",
        `repos/${typed}`,
        "--jq",
        '.full_name + " " + .default_branch',
      ]);
      if (r.code !== 0) throw new Error(firstLine(r.stderr || r.stdout));
      reply = r.stdout.trim();
    } catch (e) {
      throw new Error(`Towercab can't reach ${typed}: ${(e as Error).message}`);
    }
    // GitHub's own spelling of the name, so links and the clone's URL match it.
    const [full = "", base = ""] = reply.split(/\s+/);
    const github = ownerName(full) ?? typed;
    if (!isBranch(base)) throw new Error(`GitHub didn't say which branch is ${github}'s default`);
    const again = duplicate(d.db, short, github);
    if (again) throw new Error(again);
    repo = { name: short, github, path: "", base, workers: 1, ahead: 3, env: {} };
    const clone = clonePath(repo, d.home);
    if (existsSync(join(clone, ".git"))) {
      const url = await git(d.tools, clone, [
        "config",
        "--file",
        join(clone, ".git", "config"),
        "--get",
        "remote.origin.url",
      ]).catch(() => "");
      if (url.trim().toLowerCase() !== originUrl(repo).toLowerCase()) {
        throw new Error(`${clone} already holds a clone of another repo: move it away first`);
      }
    }
  } catch (e) {
    release();
    throw e;
  }
  const done = (async () => {
    try {
      try {
        await ensureClone(d.tools, clonePath(repo, d.home), repo, await d.github.gitAuth(repo.github));
      } catch (e) {
        throw new Error(`Towercab couldn't clone ${repo.github}: ${(e as Error).message}`);
      }
      d.db.tx(() => {
        // Checked again: the page and the CLI are different processes.
        const late = duplicate(d.db, repo.name, repo.github);
        if (late) throw new Error(late);
        insertRepo(d.db, repo, d.source, d.now);
      });
      syncRepos(d.config, d.db);
      return repo;
    } catch (e) {
      if (d.source === "ui") {
        d.db.setMeta(
          failedKey(repo.name),
          JSON.stringify({ github: repo.github, why: (e as Error).message, at: d.now }),
        );
      }
      throw e;
    } finally {
      release();
    }
  })();
  return { repo, done };
}

/** LOOP-66: `beginAddRepo`, then wait for the clone. */
export async function addRepo(d: AddRepoDeps, text: string, name?: string): Promise<RepoConfig> {
  return (await beginAddRepo(d, text, name)).done;
}

/**
 * Intents whose missions still need the repo: unfinished, or finished with their entry step (closing
 * PRs, retiring branches) still to run.
 */
function needing(db: Db, name: string): string[] {
  return db
    .all<{ intent: string }>(
      "SELECT DISTINCT intent FROM missions WHERE repo = ? AND (stage NOT IN ('done','stopped','unverified') OR step != '') ORDER BY intent",
      name,
    )
    .map((r) => r.intent);
}

/** LOOP-67: forget a repo; refused while a mission still needs it. The clone stays on disk. */
export function removeRepo(db: Db, config: Config, name: string): RepoConfig {
  const repo = db.tx(() => {
    const row = db.get<RepoRow>("SELECT * FROM repos WHERE name = ?", name);
    if (!row) throw new Error(`${name} isn't a repo Towercab knows (towercab repo list)`);
    const busy = needing(db, name);
    if (busy.length > 0) {
      throw new Error(
        `${name} still has unfinished intents (${busy.join(", ")}): let them finish or drop them first`,
      );
    }
    db.run("DELETE FROM repos WHERE name = ?", name);
    return toRepo(row);
  });
  syncRepos(config, db);
  return repo;
}

const SETTINGS = "workers, ahead, base, path or env";
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function int16(key: string, value: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value) || n < 1 || n > 16) throw new Error(`${key} must be an integer 1-16`);
  return n;
}

function envOf(env: Record<string, string>, value: string): Record<string, string> {
  const bad = new Error("env must be NAME=value or a JSON object of strings");
  if (value.trimStart().startsWith("{")) {
    let v: unknown;
    try {
      v = JSON.parse(value);
    } catch {
      throw bad;
    }
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw bad;
    const out: Record<string, string> = {};
    for (const [k, x] of Object.entries(v)) {
      if (typeof x !== "string" || !ENV_NAME.test(k)) throw bad;
      out[k] = x;
    }
    return out;
  }
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(value);
  if (!m) throw bad;
  return { ...env, [m[1]!]: m[2]! };
}

/**
 * LOOP-69: change a repo's settings, `key=value` each: `workers`, `ahead` (1-16), `base` (a branch),
 * `path` (absolute or `~/`; empty = `<home>/repos/<name>`), `env` (`NAME=value` sets one variable, a
 * JSON object of strings replaces them all). `base` and `path` wait until no mission needs the repo.
 * All or nothing: one bad pair changes nothing.
 */
export function setRepo(db: Db, config: Config, name: string, pairs: string[]): RepoConfig {
  if (pairs.length === 0) throw new Error(`say what to set (${SETTINGS}) as key=value`);
  const repo = db.tx(() => {
    const row = db.get<RepoRow>("SELECT * FROM repos WHERE name = ?", name);
    if (!row) throw new Error(`${name} isn't a repo Towercab knows (towercab repo list)`);
    const r = toRepo(row);
    for (const pair of pairs) {
      const eq = pair.indexOf("=");
      if (eq < 1) throw new Error(`${pair} isn't key=value`);
      const key = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (key === "workers" || key === "ahead") r[key] = int16(key, value);
      else if (key === "base") {
        if (!isBranch(value)) throw new Error(`base: ${value || "nothing"} is not a branch name`);
        r.base = value;
      } else if (key === "path") {
        const p = value === "" ? "" : expand(value);
        if (p !== "" && !isAbsolute(p)) throw new Error("path must be absolute or start with ~/");
        r.path = p;
      } else if (key === "env") r.env = envOf(r.env, value);
      else throw new Error(`unknown setting ${key}: use ${SETTINGS}`);
    }
    if (r.base !== row.base || r.path !== row.path) {
      const busy = needing(db, name);
      if (busy.length > 0) {
        throw new Error(
          `${name} has unfinished intents (${busy.join(", ")}): change base or path once they are done`,
        );
      }
    }
    db.run(
      "UPDATE repos SET path = ?, base = ?, workers = ?, ahead = ?, env = ? WHERE name = ?",
      r.path,
      r.base,
      r.workers,
      r.ahead,
      JSON.stringify(r.env),
      name,
    );
    return r;
  });
  syncRepos(config, db);
  return repo;
}

/** One `repo list` line (env shows names only, never values). */
export function repoLine(repo: RepoConfig, home: string): string {
  const w = `${repo.workers} worker${repo.workers === 1 ? "" : "s"}`;
  const names = Object.keys(repo.env).sort();
  const env = names.length ? ` · env ${names.join(", ")}` : "";
  return `${repo.name}: ${repo.github} · base ${repo.base} · ${w} · ahead ${repo.ahead} · ${clonePath(repo, home)}${env}`;
}

/** LOOP-67: `repo list`, one line per repo. */
export function repoList(db: Db, home: string): string {
  const rows = db.all<RepoRow>("SELECT * FROM repos ORDER BY name");
  if (rows.length === 0) return "no repos yet: add one with towercab repo add <owner/name>";
  return rows.map((r) => repoLine(toRepo(r), home) + readinessSuffix(db, r.name)).join("\n");
}

/** LOOP-72: ` · not ready (2 missing, blocking)` or `warning`; nothing for a ready or unchecked repo. */
export function readinessSuffix(db: Db, name: string): string {
  const r = parseStored(db.meta(`readiness:${name}`))?.readiness;
  if (!r || r.ready) return "";
  return ` · not ready (${missing(r).length} missing, ${r.blocks ? "blocking" : "warning"})`;
}

/** The GitHub owner most of the known repos share, to prefill `owner/` (UI-131); null when none. */
export function usualOwner(config: Config): string | null {
  const counts = new Map<string, number>();
  for (const r of config.repos.values()) {
    const owner = r.github.split("/")[0]!;
    counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [owner, n] of counts) if (best === null || n > counts.get(best)!) best = owner;
  return best;
}
