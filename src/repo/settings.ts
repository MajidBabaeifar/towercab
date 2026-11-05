// A repo's own tuning in its `TOWERCAB.md` (REPO-14 to REPO-19): `workers` and `ahead` are read from the
// base branch, changed only through a pull request, and moved there once from Towercab's database.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureClone, git } from "../checkout.ts";
import { clonePath, type RepoConfig } from "../config.ts";
import type { Db } from "../db.ts";
import type { Forge } from "../forge.ts";
import type { Tools } from "../tools.ts";
import { parseTowercab, repoGit, type TowercabFile } from "./files.ts";

export const SETTING_KEYS = ["workers", "ahead"] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];
/** A key → its new value, or `null` to take it out of the file (back to the default). */
export type Changes = Partial<Record<SettingKey, number | null>>;

export const DEFAULTS: Record<SettingKey, number> = { workers: 1, ahead: 3 };

/** What each setting means, in the words the pull request and the page use. */
export const MEANS: Record<SettingKey, string> = {
  workers: "missions building at once",
  ahead: "intents ahead of build",
};

/** REPO-14: the wait before Towercab changes repos on its own, in seconds. */
export const WAIT_S = 24 * 3600;

export const CONFIRM_TEXT =
  "An older Towercab can't read this setting; a rollback in the next day would need a manual fix.";

// --- what is kept in `meta` -------------------------------------------------------------------

/** The last good `workers`/`ahead` read from the file (REPO-15). */
export const fileKey = (repo: string) => `repo-file:${repo}`;
/** Why the file can't be read now (REPO-18). */
export const errorKey = (repo: string) => `repo-file-error:${repo}`;
/** Set once the repo's move PR merged (REPO-15, REPO-19). */
export const movedKey = (repo: string) => `repo-moved:${repo}`;
/** The number of the move PR Towercab opened (REPO-19). */
export const moveKey = (repo: string) => `repo-move:${repo}`;
/** The open (or, for a move, the last) PR of a kind. */
export const prKey = (repo: string, kind: PrKind) => `repo-pr:${repo}:${kind}`;
const countKey = (repo: string) => `repo-pr-count:${repo}`;
export const PARSER_KEY = "settings-parser";

export type PrKind = "settings" | "move";

export interface PrRecord {
  pr: number;
  n: number;
  changes: Changes;
  state: "open" | "closed" | "merged";
}

export function readRecord(db: Db, repo: string, kind: PrKind): PrRecord | null {
  const raw = db.meta(prKey(repo, kind));
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as PrRecord;
  } catch {
    return null;
  }
}

/** The last good file values; `{}` before any good read. */
export function readFileValues(db: Db, repo: string): Changes | null {
  const raw = db.meta(fileKey(repo));
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as Changes;
  } catch {
    return null;
  }
}

export const isMoved = (db: Db, repo: string) => db.meta(movedKey(repo)) !== null;

// --- validating and editing -------------------------------------------------------------------

/** REPO-14: `changes` from a request → whole numbers 1–16 or null; anything else → the reason. */
export function validateChanges(raw: unknown): Changes {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("say what to change");
  const out: Changes = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!(SETTING_KEYS as readonly string[]).includes(k)) {
      throw new Error(`${k} isn't a setting you can change here: use ${SETTING_KEYS.join(" or ")}`);
    }
    if (v === null) out[k as SettingKey] = null;
    else if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 16) out[k as SettingKey] = v;
    else throw new Error(`${k}: ${String(v)} isn't a whole number from 1 to 16`);
  }
  return out;
}

function parsed(text: string | null): Pick<TowercabFile, SettingKey> {
  if (text === null) return {};
  try {
    return parseTowercab(text);
  } catch (e) {
    throw new Error(`TOWERCAB.md: ${(e as Error).message}`);
  }
}

/**
 * REPO-16: `TOWERCAB.md` with only the keys that differ from `text` written (`null` text: no file yet).
 * Lines are replaced, added before the closing `---` or dropped one by one, so everything else stays
 * byte-identical. Returns the new text and the keys that changed.
 */
export function editTowercab(text: string | null, changes: Changes): { text: string; changed: SettingKey[] } {
  const now = parsed(text);
  const changed = SETTING_KEYS.filter((k) => k in changes && (changes[k] ?? null) !== (now[k] ?? null));
  if (changed.length === 0) return { text: text ?? "", changed };
  let lines = (text ?? "").split("\n");
  let open = lines.findIndex((l) => l.trim() !== "");
  if (text === null || open < 0 || lines[open]!.trim() !== "---") {
    // No front matter yet: it goes first, the rest of the file follows unchanged.
    lines = ["---", "---", ...(text === null ? [""] : lines)];
    open = 0;
  }
  let close = lines.findIndex((l, i) => i > open && l.trim() === "---");
  for (const k of changed) {
    const at = lines.findIndex((l, i) => i > open && i < close && new RegExp(`^${k}:(?:[ \\t]|$)`).test(l));
    const v = changes[k] ?? null;
    if (v === null) {
      if (at >= 0) {
        lines.splice(at, 1);
        close--;
      }
    } else if (at >= 0) {
      lines[at] = `${k}: ${v}${lines[at]!.endsWith("\r") ? "\r" : ""}`;
    } else {
      lines.splice(close, 0, `${k}: ${v}`);
      close++;
    }
  }
  const out = lines.join("\n");
  // The result must read back as asked, or nothing is pushed.
  const back = parsed(out);
  for (const k of changed) {
    if ((back[k] ?? null) !== (changes[k] ?? null))
      throw new Error(`${k} could not be written to TOWERCAB.md`);
  }
  return { text: out, changed };
}

// --- the 24-hour wait (REPO-19) -----------------------------------------------------------------

/** Hours left before Towercab moves settings on its own; null once the wait is over. */
export function waitHours(db: Db, now: number): number | null {
  const raw = db.meta(PARSER_KEY);
  const at = raw ? Number(raw.split(" ")[1]) : Number.NaN;
  if (!Number.isFinite(at)) return Math.ceil(WAIT_S / 3600);
  const left = at + WAIT_S - now;
  return left <= 0 ? null : Math.ceil(left / 3600);
}

/**
 * REPO-19: record the commit and time Towercab first ran the reader (never overwritten); when that
 * commit is no longer in the running checkout's history (rolled back or reverted), start again from
 * `head`.
 */
export async function recordParser(
  db: Db,
  tools: Tools,
  checkout: string,
  head: string | null,
  now: number,
): Promise<void> {
  if (!head) return;
  const raw = db.meta(PARSER_KEY);
  if (raw !== null) {
    const commit = raw.split(" ")[0]!;
    if (commit === head) return;
    const r = await tools.run("git", ["merge-base", "--is-ancestor", commit, head], { cwd: checkout });
    // 1: not an ancestor; 128: the commit is gone. Anything else is a git hiccup, tried again later.
    if (r.code !== 1 && r.code !== 128) return;
  }
  db.setMeta(PARSER_KEY, `${head} ${Math.floor(now)}`);
}

// --- the pull request ---------------------------------------------------------------------------

export interface ProposeDeps {
  db: Db;
  tools: Tools;
  forge: Pick<Forge, "openPr" | "prBrief" | "updatePrBody" | "bot" | "gitAuth">;
  /** Towercab's home root: clones live under it. */
  home: string;
  now: number;
}

/** `TOWERCAB.md` on the base branch of Towercab's clone, or null when it isn't there. */
export async function baseText(tools: Tools, clone: string, base: string): Promise<string | null> {
  const ref = `refs/remotes/origin/${base}`;
  const entry = (
    await repoGit(tools, clone, ["ls-tree", "-z", "--full-tree", ref, "--", "TOWERCAB.md"])
  ).split("\0")[0];
  if (!entry) return null;
  const [mode, , oid] = entry.slice(0, entry.indexOf("\t")).split(" ");
  if (mode !== "100644" && mode !== "100755") throw new Error("TOWERCAB.md: not a regular file");
  return repoGit(tools, clone, ["cat-file", "blob", oid!]);
}

function plain(v: number | null | undefined, key: SettingKey): string {
  return v === null || v === undefined ? `the default (${DEFAULTS[key]})` : String(v);
}

/** The pull request's text, to `prompts/writing.md`. */
export function prText(
  kind: PrKind,
  repo: RepoConfig,
  rows: { key: SettingKey; from: number | null | undefined; to: number | null }[],
): { title: string; body: string } {
  const list = rows
    .map((r) => `- \`${r.key}\` (${MEANS[r.key]}): ${plain(r.from, r.key)} → ${plain(r.to, r.key)}`)
    .join("\n");
  if (kind === "move") {
    return {
      title: "chore(towercab): move Towercab settings into TOWERCAB.md",
      body: `## What this does

Towercab's limits for ${repo.name} move from Towercab's own database into this repo's \`TOWERCAB.md\`. Nothing changes in how many missions run: the values are the ones in force today.

## Why

A repo's Towercab settings should live in the repo, where anyone can read and change them. Once this merges, Towercab reads them only from here.

## What to check before merging

Check the values below are the ones you want. Towercab never merges this itself.

## Changes

${list}
`,
    };
  }
  return {
    title: "chore(towercab): change Towercab settings",
    body: `## What this does

Changes ${rows.length === 1 ? "one Towercab setting" : "Towercab settings"} of ${repo.name} in \`TOWERCAB.md\`. It applies on Towercab's next fetch after the merge.

## Why

Asked from Towercab's repo page.

## What to check before merging

Check the new values. Towercab never merges this itself.

## Changes

${list}
`,
  };
}

/**
 * REPO-16: open (or update) the one pull request of `kind` for `repo` that writes `changes` into
 * `TOWERCAB.md`, built from the base branch with git's plumbing so Towercab's clone and its working
 * tree are untouched. Never merges. Returns the PR's number and whether it was new; `null` when the
 * base already says all of it.
 */
export async function openSettingsPr(
  d: ProposeDeps,
  repo: RepoConfig,
  changes: Changes,
  kind: PrKind,
): Promise<{ pr: number; fresh: boolean } | null> {
  const clone = clonePath(repo, d.home);
  await ensureClone(d.tools, clone, repo, await d.forge.gitAuth(repo.github));
  const base = await baseText(d.tools, clone, repo.base);
  // An open PR of this kind keeps its earlier changes; a later value for a key replaces the earlier one.
  let rec = readRecord(d.db, repo.name, kind);
  if (rec && (rec.state !== "open" || (await d.forge.prBrief(repo.github, rec.pr)).state !== "OPEN"))
    rec = null;
  const all: Changes = { ...(rec?.changes ?? {}), ...changes };
  const edit = editTowercab(base, all);
  if (edit.changed.length === 0) return null;
  const now = parsed(base);
  const rows = edit.changed.map((key) => ({ key, from: now[key], to: all[key] ?? null }));
  const n = rec?.n ?? Number(d.db.meta(countKey(repo.name)) ?? 0) + 1;
  const branch = `towercab/${kind === "move" ? "move-settings" : "settings"}-${repo.name}-${n}`;

  const tmp = mkdtempSync(join(tmpdir(), "tc-settings-"));
  try {
    const bot = await d.forge.bot();
    const env = {
      GIT_INDEX_FILE: join(tmp, "index"),
      GIT_AUTHOR_NAME: bot.login,
      GIT_AUTHOR_EMAIL: bot.email,
      GIT_COMMITTER_NAME: bot.login,
      GIT_COMMITTER_EMAIL: bot.email,
    };
    const as = { args: [], env };
    const ref = `refs/remotes/origin/${repo.base}`;
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, "TOWERCAB.md"), edit.text);
    const blob = (await git(d.tools, clone, ["hash-object", "-w", join(tmp, "TOWERCAB.md")])).trim();
    await git(d.tools, clone, ["read-tree", ref], as);
    await git(d.tools, clone, ["update-index", "--add", "--cacheinfo", `100644,${blob},TOWERCAB.md`], as);
    const tree = (await git(d.tools, clone, ["write-tree"], as)).trim();
    const text = prText(kind, repo, rows);
    const commit = (await git(d.tools, clone, ["commit-tree", tree, "-p", ref, "-m", text.title], as)).trim();
    await git(
      d.tools,
      clone,
      ["push", "--quiet", "--force", "origin", `${commit}:refs/heads/${branch}`],
      await d.forge.gitAuth(repo.github),
    );
    let pr: number;
    if (rec) {
      pr = rec.pr;
      await d.forge.updatePrBody(repo.github, pr, text.body);
    } else {
      const made = await d.forge.openPr(repo.github, {
        base: repo.base,
        head: branch,
        title: text.title,
        body: text.body,
      });
      if (made === null)
        throw new Error(`${repo.github} didn't say the number of the pull request it opened`);
      pr = made;
    }
    d.db.tx(() => {
      d.db.setMeta(countKey(repo.name), String(n));
      d.db.setMeta(
        prKey(repo.name, kind),
        JSON.stringify({ pr, n, changes: all, state: "open" } satisfies PrRecord),
      );
      if (kind === "move") d.db.setMeta(moveKey(repo.name), String(pr));
    });
    return { pr, fresh: rec === null };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** REPO-19: the keys the move writes: database values that differ from the defaults and the file lacks. */
export function moveChanges(row: { workers: number; ahead: number }, file: string | null): Changes {
  const now = parsed(file);
  const out: Changes = {};
  for (const k of SETTING_KEYS) if (now[k] === undefined && row[k] !== DEFAULTS[k]) out[k] = row[k];
  return out;
}

export interface SettingsEnv extends ProposeDeps {
  repos: Map<string, RepoConfig>;
}

function known(d: SettingsEnv, name: string): RepoConfig {
  const repo = d.repos.get(name);
  if (!repo) throw new Error(`Towercab doesn't know a repo named ${name}.`);
  return repo;
}

/**
 * REPO-14, REPO-16: the owner's save from the repo page. In the first 24 hours (REPO-19) it needs
 * `confirmed`; the reply says what happened.
 */
export async function proposeSettings(
  d: SettingsEnv,
  name: string,
  raw: unknown,
  confirmed = false,
): Promise<string> {
  const repo = known(d, name);
  const changes = validateChanges(raw);
  if (Object.keys(changes).length === 0) return "Nothing changed.";
  if (waitHours(d.db, d.now) !== null && !confirmed) throw new Error(CONFIRM_TEXT);
  const out = await openSettingsPr(d, repo, changes, "settings");
  if (!out) return "Nothing changed.";
  d.db.setMeta("repo-poll", "1");
  return out.fresh
    ? `Opened PR #${out.pr}. The change applies after it is merged.`
    : `Added your change to PR #${out.pr}. The change applies after it is merged.`;
}

function rawLimits(d: SettingsEnv, name: string): { workers: number; ahead: number } {
  const row = d.db.get<{ workers: number; ahead: number }>(
    "SELECT workers, ahead FROM repos WHERE name = ?",
    name,
  );
  if (!row) throw new Error(`Towercab doesn't know a repo named ${name}.`);
  return { workers: Number(row.workers), ahead: Number(row.ahead) };
}

/**
 * REPO-19: one PR that brings the database's non-default limits into the file. Nothing to bring → the
 * repo is marked moved and the answer is null.
 */
export async function moveRepo(d: SettingsEnv, name: string): Promise<{ pr: number } | null> {
  const repo = known(d, name);
  const clone = clonePath(repo, d.home);
  await ensureClone(d.tools, clone, repo, await d.forge.gitAuth(repo.github));
  const changes = moveChanges(rawLimits(d, name), await baseText(d.tools, clone, repo.base));
  if (Object.keys(changes).length === 0) {
    d.db.setMeta(movedKey(name), String(Math.floor(d.now)));
    return null;
  }
  const out = await openSettingsPr(d, repo, changes, "move");
  if (!out) {
    d.db.setMeta(movedKey(name), String(Math.floor(d.now)));
    return null;
  }
  return { pr: out.pr };
}

/** REPO-19: the owner asks for a closed move PR again (not held by the wait). */
export async function reopenMove(d: SettingsEnv, name: string): Promise<string> {
  known(d, name);
  if (isMoved(d.db, name)) throw new Error(`${name} has already moved`);
  const rec = readRecord(d.db, name, "move");
  if (rec?.state === "open") throw new Error(`a move PR is already open: #${rec.pr}`);
  const out = await moveRepo(d, name);
  d.db.setMeta("repo-poll", "1");
  return out
    ? `Opened PR #${out.pr}.`
    : `Nothing to move: ${name}'s settings are already the defaults, so it has moved.`;
}
