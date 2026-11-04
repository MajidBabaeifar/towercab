// Repo readiness, the impure half (REPO-23..25, REPO-27, LOOP-71): read a repo's files and settings
// through `Tools` and `GitHub`, keep the answer in `meta` `readiness:<repo>`, and propose the setup
// intent. The rules themselves are pure and live in src/repo/readiness.ts.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { ensureClone } from "./checkout.ts";
import { type Config, clonePath, type RepoConfig } from "./config.ts";
import type { Db } from "./db.ts";
import { prsOnBranch } from "./github/branches.ts";
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
  parseStored,
  type Readiness,
  repoReadiness,
  type Stored,
  suggestKind,
  wordsFor,
} from "./repo/readiness.ts";
import { check, type Tools } from "./tools.ts";

export interface ReadinessDeps {
  config: Config;
  home: Home;
  db: Db;
  tools: Tools;
  clock: Clock;
  store: IntentStore;
  github: GitHub;
  log(line: string): void;
}

/** A repo is checked again after this long (REPO-24: whenever Towercab fetches it). */
export const READINESS_EVERY_S = 600;
/** The whole check of one repo (REPO-23). */
export const READINESS_LIMIT_MS = 60_000;

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

/** REPO-25: the settings check is `ci`'s own script. */
async function settingsCheck(d: ReadinessDeps, repo: RepoConfig): Promise<Check> {
  const ci = d.config.repos.get(CI_REPO);
  const unknown = (why: string): Check => ({
    state: "unknown",
    words: `The standard settings could not be checked: ${why}`,
  });
  if (!ci) return unknown("add the ci repo to Towercab");
  const dir = clonePath(ci, d.home.root);
  const script = join(dir, "bin", "apply-settings");
  if (!existsSync(script)) return unknown("the ci repo has no bin/apply-settings");
  const r = await d.tools.run(script, ["--check", repo.github], { cwd: dir, timeoutMs: READINESS_LIMIT_MS });
  if (r.code === 0) return { state: "present" };
  if (r.code !== 1) return unknown((r.stderr || r.stdout).trim().split("\n")[0] || `exit ${r.code}`);
  const first = r.stdout.trim().split("\n")[0] || r.stderr.trim().split("\n")[0];
  return { state: "missing", words: first || wordsFor("settings") };
}

/** REPO-23: does the base branch require a status check? null when GitHub can't say. */
async function requiredChecks(d: ReadinessDeps, repo: RepoConfig): Promise<boolean | null> {
  const r = await d.github.gh(repo.github, ["api", `repos/${repo.github}/rules/branches/${repo.base}`]);
  if (r.code !== 0) return null;
  try {
    const rules = JSON.parse(r.stdout) as { type?: string }[];
    return rules.some((x) => x.type === "required_status_checks");
  } catch {
    return null;
  }
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
 * Fetch the repo and store its readiness (REPO-24). A failed fetch or read keeps the last stored
 * result (REPO-27) and the check runs again on the next try.
 */
export async function refreshReadiness(
  d: ReadinessDeps,
  repo: RepoConfig,
  force = false,
): Promise<Stored | null> {
  const old = storedReadiness(d.db, repo.name);
  if (!force && old && d.clock.now() - old.at < READINESS_EVERY_S) return old;
  try {
    const clone = clonePath(repo, d.home.root);
    const auth = await d.github.gitAuth(repo.github);
    await ensureClone(d.tools, clone, repo, auth);
    const s = await Promise.race([
      readRepo(d, repo),
      new Promise<never>((_, no) => setTimeout(() => no(new Error("timed out")), READINESS_LIMIT_MS).unref()),
    ]);
    d.db.setMeta(metaKey(repo.name), JSON.stringify(s));
    return s;
  } catch (e) {
    d.log(`readiness of ${repo.name}: ${(e as Error).message}; keeping the last result`);
    if (old) d.db.setMeta(metaKey(repo.name), JSON.stringify({ ...old, at: Math.floor(d.clock.now()) }));
    return old;
  }
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
): Promise<boolean> {
  const gaps = missing(r);
  if (gaps.length === 0) return false;
  if (listing.open.some((i) => i.repo === repo.name && i.setup === true)) return false;
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
  const out = check(
    await d.github.gh(
      intents,
      [
        "pr",
        "create",
        "-R",
        intents,
        "--base",
        "main",
        "--head",
        branch,
        "--title",
        prTitle,
        "--body-file",
        "-",
      ],
      {
        input: [
          `Towercab found ${gaps.length} missing item${gaps.length === 1 ? "" : "s"} in ${repo.name} and wrote the intent that fixes ${gaps.length === 1 ? "it" : "them"}.`,
          "Merging this pull request accepts it as work. Closing it says no; Towercab may propose it again if the gaps are still there.",
        ].join("\n\n"),
      },
    ),
    "gh pr create",
  );
  const m = /\/pull\/(\d+)/.exec(out);
  d.log(`${repo.name}: proposed a setup intent${m ? ` ${prUrl(intents, Number(m[1]))}` : ""}`);
  return true;
}
