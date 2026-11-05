// The release pass (SHIP-30..32): for every registered repo, find the release-please PR, merge it
// when it is plainly a release and main is green, else hold it. Not a mission: it needs no intent
// and never goes through `machine.apply`. Towercab only reads the PR and merges it; it never edits it.

import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import { jsonStream } from "../github/prs.ts";
import type { GitHub } from "../handlers.ts";
import { dataOf, type Mission, patchData } from "../mission.ts";
import { parseTowercab } from "../repo/files.ts";
import { DAY_S, decideRelease, type MainChecks, type PrFile } from "./release.ts";

const BOT = "github-actions[bot]";
const REFUSALS = 3;
const RAW = ["-H", "Accept: application/vnd.github.raw"];

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

async function api(d: ReleaseDeps, github: string, path: string, extra: string[] = []) {
  return d.github.gh(github, ["api", ...extra, path]);
}

async function json<T>(d: ReleaseDeps, github: string, path: string): Promise<T> {
  const r = await api(d, github, path);
  if (r.code !== 0) throw new Error(`gh api ${path}: ${r.stderr.trim() || `exit ${r.code}`}`);
  try {
    return JSON.parse(r.stdout) as T;
  } catch (e) {
    throw new Error(`gh api ${path}: ${(e as Error).message}`);
  }
}

/** A file of the default branch as text, or null when it isn't there. */
async function raw(d: ReleaseDeps, github: string, base: string, file: string): Promise<string | null> {
  const r = await api(d, github, `repos/${github}/contents/${file}?ref=${encodeURIComponent(base)}`, RAW);
  return r.code === 0 ? r.stdout : null;
}

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

interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

/** Main's head commit: its checks, judged against the required ones (SHIP-30). */
async function mainChecks(d: ReleaseDeps, github: string, base: string, sha: string): Promise<MainChecks> {
  const runs = await json<{ check_runs?: CheckRun[] }>(
    d,
    github,
    `repos/${github}/commits/${sha}/check-runs?per_page=100`,
  );
  const statuses = await json<{ statuses?: { context: string; state: string }[] }>(
    d,
    github,
    `repos/${github}/commits/${sha}/status`,
  );
  const seen = new Map<string, "green" | "pending" | "red">();
  for (const c of runs.check_runs ?? []) {
    const ok = c.status === "completed";
    const good = ["success", "neutral", "skipped"].includes(c.conclusion ?? "");
    seen.set(c.name, !ok ? "pending" : good ? "green" : "red");
  }
  for (const s of statuses.statuses ?? []) {
    seen.set(s.context, s.state === "success" ? "green" : s.state === "pending" ? "pending" : "red");
  }
  const req = await api(
    d,
    github,
    `repos/${github}/branches/${encodeURIComponent(base)}/protection/required_status_checks`,
  );
  let required: string[] = [];
  if (req.code === 0) {
    try {
      const v = JSON.parse(req.stdout) as { contexts?: string[]; checks?: { context: string }[] };
      required = [...new Set([...(v.contexts ?? []), ...(v.checks ?? []).map((c) => c.context)])];
    } catch {
      required = [];
    }
  }
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

async function prFiles(d: ReleaseDeps, github: string, n: number): Promise<PrFile[]> {
  const r = await api(d, github, `repos/${github}/pulls/${n}/files?per_page=100`, ["--paginate"]);
  if (r.code !== 0) throw new Error(`gh api pulls/${n}/files: ${r.stderr.trim() || `exit ${r.code}`}`);
  const out: PrFile[] = [];
  for (const page of jsonStream(r.stdout, "gh api files")) {
    if (!Array.isArray(page)) continue;
    for (const f of page as { filename?: string; patch?: string }[]) {
      if (typeof f.filename === "string") out.push({ name: f.filename, patch: f.patch ?? null });
    }
  }
  return out;
}

interface Pr {
  number: number;
  body: string | null;
  user: { login: string };
  head: { sha: string };
}

/** One repo: the release PR, if any, decided and acted on (SHIP-30, SHIP-31). */
async function releasePr(d: ReleaseDeps, name: string, github: string, base: string): Promise<void> {
  const owner = github.split("/")[0]!;
  const branch = `release-please--branches--${base}`;
  const list = await json<Pr[]>(
    d,
    github,
    `repos/${github}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=10`,
  );
  const pr = Array.isArray(list) ? list.find((p) => p.user?.login === BOT) : undefined;
  const prev = readRow(d.db, name);
  if (!pr) {
    if (prev) d.db.delMeta(KEY + name);
    return;
  }
  const main = await json<{ sha: string }>(d, github, `repos/${github}/commits/${encodeURIComponent(base)}`);
  const cmp = await json<{ merge_base_commit?: { sha: string } }>(
    d,
    github,
    `repos/${github}/compare/${main.sha}...${pr.head.sha}`,
  );
  const files = await prFiles(d, github, pr.number);
  const config = await raw(d, github, base, "release-please-config.json");
  const towercab = await raw(d, github, base, "TOWERCAB.md");
  let manual = false;
  if (towercab !== null) {
    try {
      manual = parseTowercab(towercab).releases === "manual";
    } catch (e) {
      d.log(
        `release PR #${pr.number} of ${name}: TOWERCAB.md is invalid, treating releases as auto: ${(e as Error).message}`,
      );
    }
  }
  const checks = await mainChecks(d, github, base, main.sha);
  const decision = decideRelease({
    manual,
    files,
    extraFiles: config ? extraFilesOf(config) : [],
    body: pr.body ?? "",
    stale: cmp.merge_base_commit?.sha !== main.sha,
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
  const again = await json<{ sha: string }>(d, github, `repos/${github}/commits/${encodeURIComponent(base)}`);
  if (again.sha !== main.sha) return;
  const m = await d.github.gh(github, [
    "pr",
    "merge",
    String(pr.number),
    "--squash",
    "--match-head-commit",
    pr.head.sha,
    "-R",
    github,
  ]);
  if (m.code === 0) {
    d.db.delMeta(KEY + name);
    d.log(`merged release PR #${pr.number} of ${name}`);
    return;
  }
  const reason = m.stderr.trim() || `exit ${m.code}`;
  const refusals = (prev && prev.pr === pr.number ? prev.refusals : 0) + 1;
  d.log(`release PR #${pr.number} of ${name}: merge refused (${refusals}): ${reason}`);
  const row: HeldRow = {
    github,
    pr: pr.number,
    reason: "refused",
    since: prev && prev.pr === pr.number ? prev.since : d.now,
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
  const list = await json<{ tag_name: string; html_url: string; draft?: boolean; created_at?: string }[]>(
    d,
    github,
    `repos/${github}/releases?per_page=20`,
  );
  const releases = (Array.isArray(list) ? list : [])
    .filter((r) => !r.draft)
    .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
  for (const m of missions) {
    for (const r of releases) {
      const c = await api(
        d,
        github,
        `repos/${github}/compare/${m.merge_sha}...${encodeURIComponent(r.tag_name)}`,
      );
      if (c.code !== 0) continue;
      let status = "";
      try {
        status = (JSON.parse(c.stdout) as { status?: string }).status ?? "";
      } catch {
        continue;
      }
      if (status === "ahead" || status === "identical") {
        patchData(d.db, m, { release: { tag: r.tag_name, url: r.html_url } }, d.now);
        d.log(`${m.intent}: published in ${r.tag_name} of ${name}`);
        break;
      }
    }
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
  const r = dataOf<{ release?: { tag: string; url: string } }>(m).release;
  if (r) return { text: `Published in ${r.tag}`, url: r.url };
  if (db.meta(`releasing:${m.repo}`) === "1") return { text: "Merged, waiting for a release", url: null };
  return null;
}
