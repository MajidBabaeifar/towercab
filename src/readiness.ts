// Repo readiness, the impure half (REPO-23..25, REPO-27, LOOP-71): read a repo's files and settings
// through `Tools` and `GitHub`, keep the answer in `meta` `readiness:<repo>`, and propose the setup
// intent. The rules themselves are pure and live in src/repo/readiness.ts.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ensureClone } from "./checkout.ts";
import { type Config, clonePath, type RepoConfig } from "./config.ts";
import type { Db } from "./db.ts";
import { isGitlab } from "./forge/types.ts";
import { prsOnBranch } from "./github/branches.ts";
import { forgeOf, limitedForge } from "./github/forge.ts";
import type { ProposedPr } from "./github/proposed.ts";
import type { Clock, GitHub } from "./handlers.ts";
import type { Home } from "./home.ts";
import { newId, slugOf } from "./intents/id.ts";
import { intentText } from "./intents/store.ts";
import type { IntentStore, Listing } from "./intents/types.ts";
import { prUrl } from "./pipeline/common.ts";
import { commitToIntents } from "./pipeline/plan.ts";
import {
  checkBase,
  defaultTowercab,
  parseTowercab,
  parseVerifying,
  repoGit,
  type TowercabFile,
} from "./repo/files.ts";
import {
  type Check,
  checkItems,
  type Evidence,
  type Kind,
  type Manifests,
  missing,
  openSetupPr,
  parseStored,
  type Readiness,
  repoReadiness,
  type Stored,
  suggestKind,
  wordsFor,
} from "./repo/readiness.ts";
import { ciRelease } from "./settings/script.ts";
import { DAY_S as SETTINGS_DAY_S, storedSettings } from "./settings/store.ts";
import { check, type RunOpts, type Tools } from "./tools.ts";

export interface ReadinessDeps {
  config: Config;
  home: Home;
  db: Db;
  tools: Tools;
  clock: Clock;
  store: IntentStore;
  github: GitHub;
  log(line: string): void;
  /** The whole check of one repo, fetch included (default {@link READINESS_LIMIT_MS}). */
  limitMs?: number;
  /** Runs the fetch of the shared clones alone, beside nothing else that touches them (the loop's lock). */
  exclusive?: <T>(fn: () => Promise<T>) => Promise<T>;
}

/** A repo is checked again after this long (REPO-24: whenever Towercab fetches it). */
export const READINESS_EVERY_S = 600;
/** The whole check of one repo (REPO-23). */
export const READINESS_LIMIT_MS = 60_000;

/** The tools and GitHub of one check, every call capped by what is left of its deadline. */
export interface Scope {
  tools: Tools;
  github: GitHub;
  /** After this every call fails with `timed out`, so a read in progress stops at its next step. */
  abort(): void;
}

/**
 * REPO-23: the 60 s of a check cover its fetch and every read. Each child process gets only the time
 * left (so a hung `git` or `gh` is killed with the limit), and once the limit passes no new call starts.
 */
export function withDeadline(d: ReadinessDeps, ms: number, now: () => number = Date.now): Scope {
  const end = now() + ms;
  let aborted = false;
  const left = (opts?: RunOpts): RunOpts => {
    const remaining = end - now();
    if (aborted || remaining <= 0) throw new Error("timed out");
    return { ...opts, timeoutMs: Math.min(opts?.timeoutMs ?? remaining, remaining) };
  };
  const tools: Tools = {
    run: async (cmd, args, opts) => d.tools.run(cmd, args, left(opts)),
    spawn: (spec) => d.tools.spawn(spec),
    which: (cmd) => d.tools.which(cmd),
    cutOff: () => d.tools.cutOff?.() ?? [],
  };
  const github = limitedForge(d.github, left);
  return {
    tools,
    github,
    abort: () => {
      aborted = true;
    },
  };
}

const metaKey = (repo: string) => `readiness:${repo}`;

export const storedReadiness = (db: Db, repo: string): Stored | null => parseStored(db.meta(metaKey(repo)));

/** The ci repo's clone, where `bin/apply-settings` lives (REPO-25). */
const CI_REPO = "ci";
const INFRA_REPO = "infra";

async function show(d: ReadinessDeps, clone: string, ref: string, path: string): Promise<string | null> {
  try {
    return await repoGit(d.tools, clone, ["show", `${ref}:${path}`]);
  } catch {
    return null;
  }
}

/**
 * REPO-25: the settings check is `ci`'s own script, from the latest `v*` release of the ci repo, never
 * from the clone's working tree. The tag's files are exported with a private index (the clone itself is
 * only read), the script runs there as the App with a minimal environment, and the tag is logged. The ci
 * clone was fetched in the pass ({@link fetchClones}).
 */
async function settingsCheck(d: ReadinessDeps, repo: RepoConfig): Promise<Check> {
  const ci = d.config.repos.get(CI_REPO);
  const unknown = (why: string): Check => ({
    state: "unknown",
    words: `The standard settings could not be checked: ${why}`,
  });
  if (!ci) return unknown("add the ci repo to Towercab");
  const dir = clonePath(ci, d.home.root);
  if (!existsSync(join(dir, ".git"))) return unknown("the ci repo has no clone yet");
  // REPO-30: the daily check's stored answer is the same answer (the two cannot disagree).
  const stored = storedSettings(d.db, repo.name);
  if (stored && stored.state !== "unknown" && d.clock.now() - stored.at < SETTINGS_DAY_S) {
    return stored.state === "ok"
      ? { state: "present" }
      : { state: "missing", words: stored.gaps[0] ?? wordsFor("settings") };
  }
  const tag = await ciRelease(d.tools, dir, ci.base);
  if (!tag) return unknown("the ci repo has no v* release yet");
  d.log(`settings check of ${repo.name}: bin/apply-settings from ci ${tag}`);
  const tree = join(d.home.root, "tmp", `ci-settings-${tag.replace(/[^\w.-]/g, "_")}`);
  const index = `${tree}.index`;
  mkdirSync(join(d.home.root, "tmp"), { recursive: true });
  rmSync(tree, { recursive: true, force: true });
  rmSync(index, { force: true });
  try {
    const gitEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) gitEnv[k] = v;
    gitEnv.GIT_INDEX_FILE = index;
    gitEnv.GIT_CEILING_DIRECTORIES = dirname(resolve(dir));
    for (const args of [
      ["read-tree", `refs/tags/${tag}`],
      ["checkout-index", "-a", "--prefix", `${tree}/`],
    ]) {
      const r = await d.tools.run("git", args, { cwd: dir, env: gitEnv, timeoutMs: READINESS_LIMIT_MS });
      if (r.code !== 0) return unknown(`ci ${tag} could not be read: ${r.stderr.trim().split("\n")[0]}`);
    }
    const script = join(tree, "bin", "apply-settings");
    if (!existsSync(script)) return unknown(`ci ${tag} has no bin/apply-settings`);
    // As the App: its token for the repo being checked, and nothing else from the loop's environment.
    const auth = await d.github.gitAuth(repo.github);
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? "",
      GH_PROMPT_DISABLED: "1",
      NO_COLOR: "1",
      ...auth.env,
    };
    const r = await d.tools.run(script, ["--check", repo.github], {
      cwd: tree,
      env,
      timeoutMs: READINESS_LIMIT_MS,
    });
    if (r.code === 0) return { state: "present" };
    if (r.code !== 1) return unknown((r.stderr || r.stdout).trim().split("\n")[0] || `exit ${r.code}`);
    const first = r.stdout.trim().split("\n")[0] || r.stderr.trim().split("\n")[0];
    return { state: "missing", words: first || wordsFor("settings") };
  } finally {
    rmSync(tree, { recursive: true, force: true });
    rmSync(index, { force: true });
  }
}

/** REPO-23: does the base branch require a status check? null when GitHub can't say. */
async function requiredChecks(d: ReadinessDeps, repo: RepoConfig): Promise<boolean | null> {
  return forgeOf(d.github).requiresStatusChecks(repo.github, repo.base);
}

/** REPO-23: the infra repo's `apps:` list names this repo. null when infra isn't known or readable. */
async function appsEntry(d: ReadinessDeps, repo: RepoConfig): Promise<boolean | null> {
  const infra = d.config.repos.get(INFRA_REPO);
  if (!infra) return null;
  const clone = clonePath(infra, d.home.root);
  const ref = `refs/remotes/origin/${infra.base}`;
  try {
    const listing = await repoGit(d.tools, clone, ["grep", "-l", "-e", "^apps:", ref]);
    const name = new RegExp(
      `(^|[^\\w.-])${repo.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w.-]|$)`,
      "m",
    );
    for (const line of listing.split("\n").filter(Boolean)) {
      const path = line.slice(ref.length + 1);
      const text = await show(d, clone, ref, path);
      if (text && name.test(text.slice(text.search(/^apps:/m)))) return true;
    }
    return false;
  } catch {
    return null;
  }
}

/** The kind, evidence and answer for one repo, from its (already fetched) clone. */
export async function readRepo(d: ReadinessDeps, repo: RepoConfig): Promise<Stored> {
  const clone = clonePath(repo, d.home.root);
  checkBase(clone, repo.base);
  const ref = `refs/remotes/origin/${repo.base}`;
  const head = (await repoGit(d.tools, clone, ["rev-parse", ref])).trim();
  const paths = (await repoGit(d.tools, clone, ["ls-tree", "-r", "--name-only", ref]))
    .split("\n")
    .filter(Boolean);

  const claude = paths.includes("CLAUDE.md") ? await show(d, clone, ref, "CLAUDE.md") : null;
  let verifying = false;
  if (claude !== null) {
    try {
      parseVerifying(claude);
      verifying = true;
    } catch {
      verifying = false;
    }
  }
  let tw: TowercabFile = defaultTowercab();
  let twError: string | null = null;
  const twText = paths.includes("TOWERCAB.md") ? await show(d, clone, ref, "TOWERCAB.md") : null;
  if (twText !== null) {
    try {
      tw = parseTowercab(twText);
    } catch (e) {
      twError = (e as Error).message;
    }
  }

  const manifests: Manifests = {};
  const pkg = paths.includes("package.json") ? await show(d, clone, ref, "package.json") : null;
  if (pkg) {
    try {
      manifests.packageJson = JSON.parse(pkg) as Manifests["packageJson"];
    } catch {
      // A broken package.json gives no hint.
    }
  }
  if (paths.includes("Cargo.toml")) manifests.cargoToml = await show(d, clone, ref, "Cargo.toml");

  const confirmed = tw.kind !== undefined;
  const kind: Kind | null = tw.kind ?? suggestKind(paths, manifests);

  const flows = paths.filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p)).slice(0, 30);
  let workflows = "";
  for (const f of flows) workflows += `${(await show(d, clone, ref, f)) ?? ""}\n`;

  const evidence: Evidence = {
    paths,
    workflows,
    requiredChecks: flows.length ? await requiredChecks(d, repo) : false,
    settings: await settingsCheck(d, repo),
    appsEntry: kind === "service" ? await appsEntry(d, repo) : null,
    verifying,
    live: tw.live,
    goLive: tw.goLive ?? null,
  };
  const result = repoReadiness(
    kind,
    confirmed,
    checkItems(kind, evidence),
    tw.waive ?? [],
    tw.readiness ?? "warn",
  );
  // REPO-27: a file that can't be read is a missing item with the parse error, not a failure.
  if (twError) {
    const k = result.items.find((i) => i.item === "kind");
    if (k) k.words = `TOWERCAB.md: ${twError}`;
  }
  return {
    base: head,
    at: Math.floor(d.clock.now()),
    readiness: result,
    goLive: tw.goLive ?? null,
    hasLive: tw.live !== null,
  };
}

/**
 * Fetch the clones a check reads: the repo's own, and the `ci` and `infra` clones it may read, each at most
 * once per {@link READINESS_EVERY_S}. This is the only part that writes to a shared clone, so the loop runs
 * it in the pass, never beside a mission's git step.
 */
async function fetchClones(d: ReadinessDeps, repo: RepoConfig): Promise<void> {
  const now = d.clock.now();
  const wanted = [repo];
  for (const name of [CI_REPO, INFRA_REPO]) {
    const other = d.config.repos.get(name);
    const at = Number(d.db.meta(`readiness-fetched:${name}`) ?? 0);
    if (other && other.name !== repo.name && now - at >= READINESS_EVERY_S) wanted.push(other);
  }
  for (const r of wanted) {
    await ensureClone(d.tools, clonePath(r, d.home.root), r, await d.github.gitAuth(r.github));
    d.db.setMeta(`readiness-fetched:${r.name}`, String(Math.floor(now)));
  }
}

/** A started check: its fetch is done; `run` reads, stores and proposes, and may run in the background. */
export interface Prepared {
  repo: RepoConfig;
  run(): Promise<void>;
}

/**
 * REPO-24: begin a repo's check. The fetch happens here, so the loop awaits it in the pass; the returned
 * `run` only reads (REPO-23), stores the result and, with `o`, proposes the setup intent (LOOP-71). One
 * deadline covers both halves. A failure keeps the last stored result (REPO-27). Null when the repo's
 * stored result is still fresh and `force` is not set.
 */
export async function beginReadiness(
  d: ReadinessDeps,
  repo: RepoConfig,
  force = false,
  o?: CycleOpts,
): Promise<Prepared | null> {
  const old = storedReadiness(d.db, repo.name);
  if (!force && old && d.clock.now() - old.at < READINESS_EVERY_S) return null;
  const limit = d.limitMs ?? READINESS_LIMIT_MS;
  let scope!: Scope;
  let inner!: ReadinessDeps;
  let expiry!: Promise<never>;
  let timer: NodeJS.Timeout | undefined;
  const failed = (e: unknown) => {
    scope?.abort();
    clearTimeout(timer);
    d.log(`readiness of ${repo.name}: ${(e as Error).message}; keeping the last result`);
    const now = Math.floor(d.clock.now());
    if (old) d.db.setMeta(metaKey(repo.name), JSON.stringify({ ...old, at: now }));
    else d.db.setMeta(`readiness-failed:${repo.name}`, String(now));
  };
  try {
    // The deadline starts once the lock is ours, and covers the fetch and the reads that follow.
    await (d.exclusive ?? ((fn) => fn()))(async () => {
      scope = withDeadline(d, limit);
      inner = { ...d, tools: scope.tools, github: scope.github };
      expiry = new Promise<never>((_, no) => {
        timer = setTimeout(() => {
          scope.abort();
          no(new Error(`timed out after ${Math.round(limit / 1000)} s`));
        }, limit);
      });
      expiry.catch(() => {});
      const fetched = fetchClones(inner, repo);
      fetched.catch(() => {});
      await Promise.race([fetched, expiry]);
    });
  } catch (e) {
    failed(e);
    return { repo, run: async () => {} };
  }
  return {
    repo,
    async run() {
      let s: Stored;
      try {
        const read = readRepo(inner, repo);
        read.catch(() => {});
        s = await Promise.race([read, expiry]);
      } catch (e) {
        failed(e);
        return;
      }
      clearTimeout(timer);
      d.db.setMeta(metaKey(repo.name), JSON.stringify(s));
      d.db.delMeta(`readiness-failed:${repo.name}`);
      if (!o) return;
      const listing = o.listing();
      const proposed = o.proposed();
      if (!listing || !proposed || !setupAttemptDue(d.db, repo.name, s.readiness, d.clock.now())) return;
      try {
        const opened = await proposeSetup(d, repo, s.readiness, listing, proposed);
        setupAttempted(d.db, repo.name, s.readiness, opened, d.clock.now());
      } catch (e) {
        d.log(`${repo.name}: couldn't propose a setup intent: ${(e as Error).message}`);
      }
    },
  };
}

/** Fetch the repo and store its readiness in one go (tests, and anything outside the loop's pass). */
export async function refreshReadiness(
  d: ReadinessDeps,
  repo: RepoConfig,
  force = false,
): Promise<Stored | null> {
  const p = await beginReadiness(d, repo, force);
  if (p) await p.run();
  return storedReadiness(d.db, repo.name);
}

/** Repos whose stored readiness holds work back (LOOP-70) → the plain text of the wait. */
export function blockingRepos(db: Db, config: Config): Map<string, Readiness> {
  const out = new Map<string, Readiness>();
  for (const name of config.repos.keys()) {
    const s = storedReadiness(db, name);
    if (s?.readiness.blocks) out.set(name, s.readiness);
  }
  return out;
}

/** The branch an open setup proposal for `repo` lives on (LOOP-71). */
export const setupBranch = (repo: string) => `setup/${repo}`;

/**
 * LOOP-71: one pull request in the intents repo that proposes the intent setting `repo` up, unless an
 * intent with `setup: true` is already open for it or a proposal is still open. True when one was opened.
 */
export async function proposeSetup(
  d: ReadinessDeps,
  repo: RepoConfig,
  r: Readiness,
  listing: Listing,
  proposed: ProposedPr[] = [],
): Promise<boolean> {
  const gaps = missing(r);
  if (gaps.length === 0) return false;
  if (listing.open.some((i) => i.repo === repo.name && i.setup === true)) return false;
  // LOOP-92: a setup PR from anywhere (the standards review, the owner) counts as open.
  if (openSetupPr(proposed, repo.name)) return false;
  const intents = d.store.github();
  if (!intents) return false;
  const branch = setupBranch(repo.name);
  if ((await prsOnBranch(d.github, intents, branch)).some((p) => p.state === "OPEN")) return false;

  const now = new Date(d.clock.now() * 1000);
  const taken = new Set<string>([
    ...listing.open.map((i) => i.id),
    ...listing.done.map((i) => i.id),
    ...listing.doneIds,
    ...listing.unreadable.flatMap((u) => (u.id ? [u.id] : [])),
  ]);
  const id = newId(now, taken);
  const title = `${repo.name} is set up as a ${r.kind ?? "repo"} and ready for work`;
  const text = intentText(
    {
      repo: repo.name,
      title,
      u: 4,
      i: 4,
      source: "towercab",
      fields: { setup: "true" },
      body: [
        "## Problem",
        "",
        `Towercab checked ${repo.name} and found setup it needs but doesn't have yet:`,
        "",
        ...gaps.map((g) => `- ${g.words}`),
        "",
        "## Proposed outcome",
        "",
        ...gaps.map((g) => `- ${g.item}: ${g.words.replace(/^[^:]*:\s*/, "")}`),
      ].join("\n"),
    },
    now,
  );
  const prTitle = `docs(intents): add ${id} ${title}`;
  const cx = { config: d.config, home: d.home, tools: d.tools, github: d.github, store: d.store };
  await commitToIntents(
    cx,
    branch,
    "origin/main",
    { [`intents/${id}-${slugOf(title)}/intent.md`]: text },
    prTitle,
    "setup",
  );
  const n = await forgeOf(d.github).openPr(intents, {
    base: "main",
    head: branch,
    title: prTitle,
    body: [
      setupMark(repo.name),
      `Towercab found ${gaps.length} missing item${gaps.length === 1 ? "" : "s"} in ${repo.name} and wrote the intent that fixes ${gaps.length === 1 ? "it" : "them"}.`,
      "Merging this pull request accepts it as work. Closing it says no; Towercab may propose it again if the gaps are still there.",
    ].join("\n\n"),
  });
  d.log(`${repo.name}: proposed a setup intent${n ? ` ${prUrl(intents, n)}` : ""}`);
  return true;
}

/** LOOP-71: the mark in a setup PR's body, keyed by repo. */
export const setupMark = (repo: string) => `<!-- towercab:setup repo=${repo} -->`;

const DAY_S = 86_400;

/** The missing items of a result as one comparable key; empty when nothing is missing. */
export const missingKey = (r: Readiness): string =>
  missing(r)
    .map((i) => i.item)
    .sort()
    .join(",");

/**
 * LOOP-71: a proposal is tried only when the set of missing items differs from the one last tried
 * (items, never the stored time), and at most once a day per repo. A closed proposal is a no: the same
 * set is not proposed again. Nothing missing clears the memory, so a later gap is new.
 */
export function setupAttemptDue(db: Db, repo: string, r: Readiness, now: number): boolean {
  const key = missingKey(r);
  if (!key) {
    db.delMeta(`setup-seen:${repo}`);
    return false;
  }
  if (db.meta(`setup-seen:${repo}`) === key) return false;
  const last = Number(db.meta(`setup-proposed:${repo}`) ?? 0);
  return now - last >= DAY_S;
}

/** Remember the set tried; `opened` also starts the day's wait. */
export function setupAttempted(db: Db, repo: string, r: Readiness, opened: boolean, now: number): void {
  db.setMeta(`setup-seen:${repo}`, missingKey(r));
  if (opened) db.setMeta(`setup-proposed:${repo}`, String(Math.floor(now)));
}

export interface CycleOpts {
  /** The intents repo as last read; null before the first read. */
  listing(): Listing | null;
  /** The open proposed PRs (LOOP-92); null while unknown, then nothing is proposed. */
  proposed(): ProposedPr[] | null;
}

/** The repo whose check is due and oldest (never checked first), or null. A failed first read waits too. */
export function nextDue(d: ReadinessDeps): RepoConfig | null {
  let best: { repo: RepoConfig; at: number } | null = null;
  const now = d.clock.now();
  for (const repo of d.config.repos.values()) {
    // GL-3: the readiness checks read GitHub only; a GitLab repo has none until the pipeline supports it.
    if (isGitlab(repo.github)) continue;
    const at = storedReadiness(d.db, repo.name)?.at ?? 0;
    const failedAt = Number(d.db.meta(`readiness-failed:${repo.name}`) ?? 0);
    if (at !== 0 && now - at < READINESS_EVERY_S) continue;
    if (failedAt !== 0 && now - failedAt < READINESS_EVERY_S) continue;
    if (!best || at < best.at) best = { repo, at };
  }
  return best?.repo ?? null;
}

/**
 * The oldest due repo: fetched here (awaited), read and proposed by the returned `run`. Null when none is
 * due. Never throws.
 */
export async function startReadiness(d: ReadinessDeps, o: CycleOpts): Promise<Prepared | null> {
  const repo = nextDue(d);
  return repo ? beginReadiness(d, repo, false, o) : null;
}

/** One whole step, fetch and read: the repo's name, or null when none was due. */
export async function readinessCycle(d: ReadinessDeps, o: CycleOpts): Promise<string | null> {
  const p = await startReadiness(d, o);
  if (!p) return null;
  await p.run();
  return p.repo.name;
}
