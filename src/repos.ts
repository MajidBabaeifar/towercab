// Repos at runtime (LOOP-65..68): the `repos` table, the one-time import of config tables, and
// `repo add | remove | list`. `Config.repos` stays the one Map the rest of the code reads; this
// module keeps it equal to the table.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { ensureClone, git, originUrl } from "./checkout.ts";
import { type Config, clonePath, isBranch, isRepoName, type RepoConfig } from "./config.ts";
import type { Db } from "./db.ts";
import type { GitHub } from "./handlers.ts";
import { unfinished } from "./mission.ts";
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

const OWNER_NAME = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

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
        `${table} is ignored: the repo is in Towercab's database now (towercab repo list). Delete the table.`,
      );
      config.badRepos.delete(name);
    } else if (db.meta(importedKey(name)) !== null) {
      config.ignoredRepos.set(
        name,
        `${table} is ignored: the repo was removed with towercab repo remove. Delete the table.`,
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
  return OWNER_NAME.test(s) ? s : null;
}

function duplicate(db: Db, name: string, github: string): string | null {
  const known = readRepos(db);
  const same = known.find((r) => r.name === name);
  if (same) return `${name} is already a repo (${same.github})`;
  const twin = known.find((r) => r.github.toLowerCase() === github.toLowerCase());
  if (twin) return `${github} is already added as ${twin.name}`;
  return null;
}

/**
 * LOOP-66: add `owner/name` as the repo `name` (default: the repo part). Checks that Towercab's GitHub
 * App reaches it, takes its default branch as `base`, clones it into `<home>/repos/<name>`, and stores
 * it. Every refusal is an Error whose message is the reason.
 */
export async function addRepo(d: AddRepoDeps, text: string, name?: string): Promise<RepoConfig> {
  const github = ownerName(text);
  if (!github) throw new Error(`${text.trim() || "nothing"} isn't a GitHub repo: write it as owner/name`);
  const short = name?.trim() || github.split("/")[1]!;
  if (!isRepoName(short) || short === "intents") {
    throw new Error(`${short} can't be a repo name: use letters, digits, dots, dashes and underscores`);
  }
  const dup = duplicate(d.db, short, github);
  if (dup) throw new Error(dup);

  let base: string;
  try {
    const r = await d.github.gh(github, ["api", `repos/${github}`, "--jq", ".default_branch"]);
    if (r.code !== 0) throw new Error(firstLine(r.stderr || r.stdout));
    base = r.stdout.trim();
  } catch (e) {
    throw new Error(`Towercab can't reach ${github}: ${(e as Error).message}`);
  }
  if (!isBranch(base)) throw new Error(`GitHub didn't say which branch is ${github}'s default`);

  const repo: RepoConfig = { name: short, github, path: "", base, workers: 1, ahead: 3, env: {} };
  const clone = clonePath(repo, d.home);
  if (existsSync(join(clone, ".git"))) {
    const url = await git(d.tools, clone, [
      "config",
      "--file",
      join(clone, ".git", "config"),
      "--get",
      "remote.origin.url",
    ]).catch(() => "");
    if (url.trim() !== originUrl(repo)) {
      throw new Error(`${clone} already holds a clone of another repo: move it away first`);
    }
  }
  try {
    await ensureClone(d.tools, clone, repo, await d.github.gitAuth(github));
  } catch (e) {
    throw new Error(`Towercab couldn't clone ${github}: ${(e as Error).message}`);
  }
  d.db.tx(() => {
    // Checked again: the page and the CLI may add at the same time.
    const again = duplicate(d.db, short, github);
    if (again) throw new Error(again);
    insertRepo(d.db, repo, d.source, d.now);
  });
  syncRepos(d.config, d.db);
  return repo;
}

/** LOOP-67: forget a repo; refused while an unfinished mission uses it. The clone stays on disk. */
export function removeRepo(db: Db, config: Config, name: string): RepoConfig {
  const repo = db.tx(() => {
    const row = db.get<RepoRow>("SELECT * FROM repos WHERE name = ?", name);
    if (!row) throw new Error(`${name} isn't a repo Towercab knows (towercab repo list)`);
    const busy = unfinished(db)
      .filter((m) => m.repo === name)
      .map((m) => m.intent);
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

/** LOOP-67: `repo list`, one line per repo. */
export function repoList(db: Db, home: string): string {
  const rows = db.all<RepoRow>("SELECT * FROM repos ORDER BY name");
  if (rows.length === 0) return "no repos yet: add one with towercab repo add <owner/name>";
  return rows
    .map((r) => {
      const repo = toRepo(r);
      const w = `${repo.workers} worker${repo.workers === 1 ? "" : "s"}`;
      return `${repo.name}: ${repo.github} · base ${repo.base} · ${w} · ahead ${repo.ahead} · ${clonePath(repo, home)}`;
    })
    .join("\n");
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
