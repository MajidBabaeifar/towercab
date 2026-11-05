// The release pass (SHIP-30..32): for every registered repo, find the release-please PR, merge it
// when it is plainly a release and main is green, else hold it. Not a mission: it needs no intent
// and never goes through `machine.apply`. Towercab only reads the PR and merges it; it never edits it.

import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import { MERGE_METHOD } from "../forge.ts";
import { forgeOf } from "../github/forge.ts";
import type { GitHub } from "../handlers.ts";
import { dataOf, getMission, type Mission, patchData } from "../mission.ts";
import { parseTowercab } from "../repo/files.ts";
import { DAY_S, decideRelease, type MainChecks, type PrFile } from "./release.ts";

const BOT = "github-actions[bot]";
const REFUSALS = 3;
/** How many releases the lookup reads, and how many missions it looks up in one pass (SHIP-32). */
const RELEASES_READ = 100;
const LOOKUPS_PER_PASS = 5;

export interface ReleaseDeps {
  github: GitHub;
  db: Db;
  config: Config;
  now: number;
  log(line: string): void;
}

/** The stored state of one held release PR: `meta` key `release:<repo>`. */
export interface HeldRow {
  github: string;
  pr: number;
  reason: string;
  since: number;
  /** A card shows at once (not after a day). */
  immediate: boolean;
  /** Why it is held, in a sentence. */
  why: string;
  /** The end of the card's title: "needs you", "has waited a day". */
  title: string;
  refusals: number;
}

export interface Held extends HeldRow {
  repo: string;
  /** The card is showing: held for a reason that needs the owner, or for a day. */
  card: boolean;
}

const KEY = "release:";

function readRow(db: Db, repo: string): HeldRow | null {
  const raw = db.meta(KEY + repo);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as HeldRow;
  } catch {
    return null;
  }
}

/** The held release PRs, with whether their card shows (SHIP-31). */
export function heldReleases(db: Db, now: number): Held[] {
  const out: Held[] = [];
  for (const r of db.all<{ key: string; value: string }>(
    "SELECT key, value FROM meta WHERE key LIKE 'release:%' ORDER BY key",
  )) {
    const repo = r.key.slice(KEY.length);
    const row = readRow(db, repo);
    if (!row) continue;
    out.push({ ...row, repo, card: row.immediate || now - row.since >= DAY_S });
  }
  return out;
}

/** The card's title (SHIP-31). */
export function releaseTitle(h: Held): string {
  return `Release PR #${h.pr} of ${h.repo} ${h.title}`;
}

/** A file of the default branch as text, or null when it isn't there. */
const raw = (d: ReleaseDeps, github: string, base: string, file: string) =>
  forgeOf(d.github).readFile(github, file, base);

function isJsonObject(text: string): boolean {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v);
  } catch {
    return false;
  }
}

/** `extra-files` paths of a release-please config (top level and per package). */
export function extraFilesOf(configText: string): string[] {
  let c: unknown;
  try {
    c = JSON.parse(configText);
  } catch {
    return [];
  }
  const out: string[] = [];
  const take = (v: unknown) => {
    if (!Array.isArray(v)) return;
    for (const e of v) {
      if (typeof e === "string") out.push(e);
      else if (e && typeof e === "object" && typeof (e as { path?: unknown }).path === "string")
        out.push((e as { path: string }).path);
    }
  };
  if (c && typeof c === "object") {
    const o = c as Record<string, unknown>;
    take(o["extra-files"]);
    const pk = o.packages;
    if (pk && typeof pk === "object") {
      for (const [dir, p] of Object.entries(pk as Record<string, unknown>)) {
        const files = p && typeof p === "object" ? (p as Record<string, unknown>)["extra-files"] : undefined;
        const before = out.length;
        take(files);
        if (dir !== ".") for (let i = before; i < out.length; i++) out[i] = `${dir}/${out[i]}`;
      }
    }
  }
  return out;
}

/** Main's head commit: its checks, judged against the required ones (SHIP-30). */
async function mainChecks(d: ReleaseDeps, github: string, base: string, sha: string): Promise<MainChecks> {
  const { seen, required } = await forgeOf(d.github).commitChecks(github, sha, base);
  const names = required.length ? required : [...seen.keys()];
  if (names.length === 0) return { state: "none", names: [] };
  const bad: string[] = [];
  let red = false;
  for (const n of names) {
    const s = seen.get(n) ?? "pending";
    if (s === "green") continue;
    bad.push(n);
    if (s === "red") red = true;
  }
  if (bad.length === 0) return { state: "green", names: [] };
  return { state: red ? "red" : "pending", names: bad };
}

/** One repo: the release PR, if any, decided and acted on (SHIP-30, SHIP-31). */
async function releasePr(d: ReleaseDeps, name: string, github: string, base: string): Promise<void> {
  const branch = `release-please--branches--${base}`;
  const pr = (await forgeOf(d.github).openPrsFrom(github, branch)).find((p) => p.author === BOT);
  const prev = readRow(d.db, name);
  if (!pr) {
    if (prev) d.db.delMeta(KEY + name);
    return;
  }
  const main = { sha: await forgeOf(d.github).branchHead(github, base) };
  const mergeBase = await forgeOf(d.github).mergeBase(github, main.sha, pr.head);
  const files: PrFile[] = await forgeOf(d.github).prPatches(github, pr.number);
  const config = await raw(d, github, base, "release-please-config.json");
  const towercab = await raw(d, github, base, "TOWERCAB.md");
  let manual = false;
  let invalid: string | undefined;
  if (towercab !== null) {
    try {
      manual = parseTowercab(towercab).releases === "manual";
    } catch (e) {
      // A TOWERCAB.md that won't parse might hide `releases: manual`: hold, never merge.
      invalid = (e as Error).message;
      d.log(`release PR #${pr.number} of ${name}: TOWERCAB.md is invalid, holding it: ${invalid}`);
    }
  }
  const checks = await mainChecks(d, github, base, main.sha);
  const decision = decideRelease({
    manual,
    ...(invalid === undefined ? {} : { invalid }),
    files,
    extraFiles: config ? extraFilesOf(config) : [],
    body: pr.body ?? "",
    stale: (mergeBase ?? undefined) !== main.sha,
    checks,
  });
  if (decision.kind === "hold") {
    const same = prev && prev.pr === pr.number && prev.reason === decision.reason;
    const row: HeldRow = {
      github,
      pr: pr.number,
      reason: decision.reason,
      since: same ? prev.since : d.now,
      immediate: decision.immediate,
      why: decision.why,
      title: decision.title,
      refusals: 0,
    };
    d.db.setMeta(KEY + name, JSON.stringify(row));
    return;
  }
  // Main is read again just before the merge; the merge names the PR head that was inspected.
  const again = { sha: await forgeOf(d.github).branchHead(github, base) };
  if (again.sha !== main.sha) return;
  const m = await forgeOf(d.github).mergePr(github, pr.number, { method: MERGE_METHOD, head: pr.head });
  if (m.ok) {
    d.db.delMeta(KEY + name);
    d.log(`merged release PR #${pr.number} of ${name}`);
    return;
  }
  const reason = m.reason || "failed";
  // Refusals count in a row, and their clock starts at the first one, not at an earlier hold.
  const before = prev && prev.pr === pr.number && prev.reason === "refused" ? prev : null;
  const refusals = (before?.refusals ?? 0) + 1;
  d.log(`release PR #${pr.number} of ${name}: merge refused (${refusals}): ${reason}`);
  const row: HeldRow = {
    github,
    pr: pr.number,
    reason: "refused",
    since: before ? before.since : d.now,
    immediate: refusals >= REFUSALS,
    why: `GitHub refused the merge: ${reason}`,
    title: "needs you",
    refusals,
  };
  d.db.setMeta(KEY + name, JSON.stringify(row));
}

/** SHIP-32: the first release whose tag contains the merge commit of each finished mission. */
async function published(d: ReleaseDeps, name: string, github: string): Promise<void> {
  const missions = d.db
    .all<Mission>(
      "SELECT * FROM missions WHERE repo = ? AND stage IN ('done','unverified') AND merge_sha IS NOT NULL ORDER BY id",
      name,
    )
    .filter((m) => !dataOf<{ release?: unknown }>(m).release);
  if (missions.length === 0) return;
  const list = await forgeOf(d.github).listReleases(github, RELEASES_READ);
  // Past this many, older releases exist that we didn't read.
  const truncated = list.length >= RELEASES_READ;
  const releases = list.filter((r) => !r.draft).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const newest = releases[releases.length - 1];
  if (!newest) return;
  // Does the release's tag contain the commit? null: GitHub couldn't say.
  const contains = (sha: string, tag: string) => forgeOf(d.github).tagContains(github, sha, tag);
  // The mission as it is now: its data may have changed during the awaited calls.
  const patch = (m: Mission, set: Record<string, unknown>) => {
    const fresh = getMission(d.db, m.id);
    if (fresh) patchData(d.db, fresh, set, d.now);
  };
  let looked = 0;
  for (const m of missions) {
    const data = dataOf<{ releaseChecked?: string; releaseUnknown?: boolean }>(m);
    // A mission already found not to be in the newest release waits until a newer one appears:
    // this costs one compare per mission per new release, not per pass.
    if (data.releaseChecked === newest.tag || data.releaseUnknown) continue;
    // A backlog of old missions is worked off a few at a time, so a pass never stalls the loop.
    if (looked >= LOOKUPS_PER_PASS) break;
    looked++;
    const inNewest = await contains(m.merge_sha!, newest.tag);
    if (inNewest === null) continue;
    if (!inNewest) {
      patch(m, { releaseChecked: newest.tag });
      continue;
    }
    // Releases are in order, so containing is monotone: a binary search finds the first one.
    let lo = 0;
    let hi = releases.length - 1;
    let failed = false;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const has = await contains(m.merge_sha!, releases[mid]!.tag);
      if (has === null) {
        failed = true;
        break;
      }
      if (has) hi = mid;
      else lo = mid + 1;
    }
    if (failed) continue;
    const r = releases[lo]!;
    if (lo === 0 && truncated) {
      // Even the oldest release read contains it: the first one is older than we can see, and a
      // wrong tag is worse than none, so the page shows no release line for this change.
      patch(m, { releaseUnknown: true, releaseChecked: undefined });
      continue;
    }
    patch(m, { release: { tag: r.tag, url: r.url }, releaseChecked: undefined });
    d.log(`${m.intent}: published in ${r.tag} of ${name}`);
  }
}

/**
 * One release pass over every registered repo. A repo that fails is logged and skipped; the first
 * failure's message is returned so the loop can report GitHub as unreachable.
 */
export async function runReleases(d: ReleaseDeps): Promise<string | null> {
  let failure: string | null = null;
  for (const [name, repo] of d.config.repos) {
    try {
      const config = await raw(d, repo.github, repo.base, "release-please-config.json");
      if (config === null || !isJsonObject(config)) {
        d.db.delMeta(`releasing:${name}`);
        d.db.delMeta(KEY + name);
        continue;
      }
      d.db.setMeta(`releasing:${name}`, "1");
      await releasePr(d, name, repo.github, repo.base);
      await published(d, name, repo.github);
    } catch (e) {
      failure ??= (e as Error).message;
      d.log(`release pass of ${name} failed: ${(e as Error).message}`);
    }
  }
  return failure;
}

/** SHIP-32: what the intent page says about the release of a finished mission, or null. */
export function releaseLine(db: Db, m: Mission): { text: string; url: string | null } | null {
  if (m.stage !== "done" && m.stage !== "unverified") return null;
  const data = dataOf<{ release?: { tag: string; url: string }; releaseUnknown?: boolean }>(m);
  const r = data.release;
  if (data.releaseUnknown) return null;
  if (r) return { text: `Published in ${r.tag}`, url: r.url };
  if (db.meta(`releasing:${m.repo}`) === "1") return { text: "Merged, waiting for a release", url: null };
  return null;
}
