// Setting up checks for a repo that has none (REPO-5, REPO-34..37): draft a verifying section from what the
// repo holds, prove it on the base branch, open it as a one-file PR, drive that PR like any other change,
// and let every intent that waits for it carry on once it merges. The state lives in `meta`
// (`setup-checks:<repo>`); missions only wait on it (src/pipeline/start.ts).

import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { effectiveA, gate, OWNER_MERGES } from "./autonomy.ts";
import { levelNow } from "./autonomy-change.ts";
import { ensureClone, git, gitEnv, NO_HOOKS } from "./checkout.ts";
import { type Config, clonePath, type RepoConfig } from "./config.ts";
import type { Db } from "./db.ts";
import { isGitlab } from "./forge/types.ts";
import { MERGE_METHOD } from "./forge.ts";
import type { Clock, Host } from "./handlers.ts";
import type { Home } from "./home.ts";
import type { IntentStore } from "./intents/types.ts";
import { type Mission, unfinished } from "./mission.ts";
import { script } from "./pipeline/checks.ts";
import { bucket } from "./pipeline/ci.ts";
import { cacheEnv, sandboxArgv, sandboxEnv } from "./pipeline/sandbox.ts";
import {
  commandIsCheckOnly,
  type Draft,
  draftPrBody,
  draftVerifying,
  insertVerifying,
  wanted,
} from "./repo/draft.ts";
import { parseTowercab, parseVerifying } from "./repo/files.ts";
import type { Tools } from "./tools.ts";

/** How long a repo's setup PR may be unread by the job (s). */
const POLL_S = 30;
/** CI is given this long after the push before "no checks" counts as none (PIP-3's grace). */
const CI_GRACE_S = 120;
const RUN_TAIL = 4000;

export type SetupState = "drafting" | "pushing" | "open" | "merged" | "closed" | "failed";

export interface SetupRecord {
  state: SetupState;
  base: string;
  /** Sources tried, in order (REPO-37's ask names them). */
  tried: string[];
  lastFailure?: string;
  /** Intents that were asked: a reply from one of them starts a new draft. */
  asked: string[];
  draft?: Draft;
  output?: string;
  branch?: string;
  pr?: number;
  head?: string;
  pushedAt?: number;
  polledAt?: number;
  /** Errors in a row, and when the next try is due. */
  errors?: number;
  retryAt?: number;
  /** The head a review passed on, and the head it blocked. */
  reviewedHead?: string;
  blockedHead?: string;
  /** The head whose "waiting for you" comment is posted. */
  heldHead?: string;
}

export interface SetupDeps {
  config: Config;
  home: Home;
  db: Db;
  tools: Tools;
  clock: Clock;
  store: IntentStore;
  github: Host;
  log(line: string): void;
  /** Holds the loop's clone lock around a fetch. */
  exclusive?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export const setupKey = (repo: string): string => `setup-checks:${repo}`;

export function getSetup(db: Db, repo: string): SetupRecord | null {
  const raw = db.meta(setupKey(repo));
  return raw === null ? null : (JSON.parse(raw) as SetupRecord);
}

export function putSetup(db: Db, repo: string, rec: SetupRecord): void {
  db.setMeta(setupKey(repo), JSON.stringify(rec));
}

export function dropSetup(db: Db, repo: string): void {
  db.delMeta(setupKey(repo));
}

/** A fresh record: the draft is worked out on the next pass of the loop. */
export function startSetup(db: Db, repo: RepoConfig): SetupRecord {
  const rec: SetupRecord = { state: "drafting", base: repo.base, tried: [], asked: [] };
  putSetup(db, repo.name, rec);
  return rec;
}

export const WAIT_PREFIX = "setting up checks";

/** The branch of a repo's setup PR (REPO-36). */
export const setupBranch = (repo: string): string => `towercab/setup-${repo}`;

const lastLine = (text: string): string =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("$ "))
    .pop() ?? "";

// -- the sandbox ---------------------------------------------------------------------------------------

/** `refs/remotes/origin/<base>` exported to `dest` with a private index; the clone is only read. */
async function exportTree(d: SetupDeps, clone: string, ref: string, dest: string): Promise<void> {
  rmSync(dest, { recursive: true, force: true });
  rmSync(`${dest}.index`, { force: true });
  mkdirSync(dirname(dest), { recursive: true });
  const env = {
    ...gitEnv(clone),
    GIT_INDEX_FILE: `${dest}.index`,
    GIT_CEILING_DIRECTORIES: dirname(resolve(clone)),
  };
  try {
    for (const args of [
      ["read-tree", ref],
      ["checkout-index", "-a", "--prefix", `${dest}/`],
    ]) {
      const r = await d.tools.run("git", [...NO_HOOKS, ...args], { cwd: clone, env, timeoutMs: 120_000 });
      if (r.code !== 0) throw new Error(`git ${args[0]}: ${r.stderr.trim().split("\n")[0]}`);
    }
  } finally {
    rmSync(`${dest}.index`, { force: true });
  }
}

interface Ran {
  ok: boolean;
  output: string;
  /** Why it failed, in one line. */
  why: string;
}

/** Setup (with network) then checks (without), each line echoed, in the sandbox of PIP-23. */
async function runDraft(
  d: SetupDeps,
  repo: RepoConfig,
  dir: string,
  setup: string[],
  checks: string[],
): Promise<Ran> {
  const home = homedir();
  const cache = d.home.cache(repo.name);
  const env = sandboxEnv(home, d.config, cacheEnv(cache, d.config, repo));
  let output = "";
  for (const [lines, network] of [
    [setup, true],
    [checks, false],
  ] as const) {
    if (!lines.length) continue;
    const argv = sandboxArgv({
      checkout: dir,
      home,
      toolchain: d.config.agent.toolchain,
      cache,
      network,
      cacheWritable: network,
      line: script([...lines]),
    });
    const r = await d.tools.run(argv[0]!, argv.slice(1), {
      cwd: dir,
      env,
      timeoutMs: d.config.agent.checkTimeoutMin * 60_000,
    });
    output += `${r.stdout}${r.stderr}`;
    if (r.code !== 0 || r.timedOut) {
      const how = r.timedOut ? "timed out" : `exit ${r.code}`;
      return { ok: false, output: `${output}\n${how}`, why: lastLine(`${r.stderr}\n${r.stdout}`) || how };
    }
  }
  return { ok: true, output, why: "" };
}

// -- drafting (REPO-34, REPO-35) -----------------------------------------------------------------------

async function fetchBase(d: SetupDeps, repo: RepoConfig, clone: string): Promise<string> {
  const auth = await d.github.gitAuth(repo.github);
  const fetch = () => ensureClone(d.tools, clone, repo, auth);
  await (d.exclusive ? d.exclusive(fetch) : fetch());
  return (await git(d.tools, clone, ["rev-parse", `refs/remotes/origin/${repo.base}`])).trim();
}

/** Work out the drafts, run them on the base branch, keep the first that passes. */
async function draftPhase(d: SetupDeps, repo: RepoConfig, rec: SetupRecord): Promise<SetupRecord> {
  const clone = clonePath(repo, d.home.root);
  const ref = `refs/remotes/origin/${repo.base}`;
  const sha = await fetchBase(d, repo, clone);
  const paths = (await git(d.tools, clone, ["ls-tree", "-r", "--name-only", ref]))
    .split("\n")
    .filter(Boolean);
  const texts: Record<string, string> = {};
  for (const p of wanted(paths)) {
    try {
      texts[p] = await git(d.tools, clone, ["show", `${ref}:${p}`]);
    } catch {
      // Unreadable: the draft goes without it.
    }
  }
  let tests: string[] | undefined;
  if (texts["TOWERCAB.md"] !== undefined) {
    try {
      tests = parseTowercab(texts["TOWERCAB.md"]).tests;
    } catch {
      // The invalid file is reported by the pick; the default globs stand here.
    }
  }
  const drafts = draftVerifying({
    paths,
    texts,
    ...(tests ? { tests } : {}),
    has: { python3: d.tools.which("python3") !== null, node: d.tools.which("node") !== null },
  });
  const tried: string[] = [];
  let lastFailure = "";
  const scratch = join(d.home.root, "setup", repo.name);
  try {
    for (const draft of drafts) {
      tried.push(draft.source);
      await exportTree(d, clone, ref, scratch);
      const ran = await runDraft(d, repo, scratch, draft.setup, draft.checks);
      if (ran.ok) {
        d.log(`${repo.name}: drafted checks from ${draft.source} pass on ${repo.base}`);
        return {
          ...rec,
          state: "pushing",
          base: repo.base,
          tried,
          draft,
          output: ran.output.slice(-RUN_TAIL),
          head: sha,
        };
      }
      lastFailure = `${draft.source}: ${ran.why}`;
      d.log(`${repo.name}: drafted checks from ${draft.source} failed on ${repo.base}: ${lastFailure}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return {
    ...rec,
    state: "failed",
    tried,
    lastFailure: drafts.length ? lastFailure : "nothing in the repo to draft checks from",
  };
}

// -- the pull request (REPO-36) ------------------------------------------------------------------------

/** Commit `CLAUDE.md` alone on top of the base with git's plumbing: no working tree, nothing else can slip in. */
async function commitClaude(
  d: SetupDeps,
  repo: RepoConfig,
  rec: SetupRecord,
  clone: string,
): Promise<string> {
  const draft = rec.draft!;
  const ref = `refs/remotes/origin/${repo.base}`;
  const baseSha = (await git(d.tools, clone, ["rev-parse", ref])).trim();
  let old: string | null = null;
  let mode = "100644";
  const entry = (await git(d.tools, clone, ["ls-tree", ref, "CLAUDE.md"])).trim();
  if (entry) {
    mode = entry.split(/\s+/)[0]!;
    old = await git(d.tools, clone, ["show", `${ref}:CLAUDE.md`]);
  }
  const text = insertVerifying(old, draft, repo.name);
  const bot = await d.github.bot();
  const index = join(d.home.root, "tmp", `setup-${repo.name}.index`);
  mkdirSync(dirname(index), { recursive: true });
  const base = gitEnv(clone);
  const env = { ...base, GIT_INDEX_FILE: index };
  const run = async (args: string[], e: Record<string, string>, input?: string): Promise<string> => {
    const r = await d.tools.run("git", [...NO_HOOKS, ...args], {
      cwd: clone,
      env: e,
      timeoutMs: 120_000,
      ...(input !== undefined ? { input } : {}),
    });
    if (r.code !== 0) throw new Error(`git ${args[0]}: ${r.stderr.trim().split("\n")[0]}`);
    return r.stdout.trim();
  };
  try {
    const blob = await run(["hash-object", "-w", "--stdin"], base, text);
    await run(["read-tree", baseSha], env);
    await run(["update-index", "--add", "--cacheinfo", `${mode},${blob},CLAUDE.md`], env);
    const tree = await run(["write-tree"], env);
    const who = {
      ...base,
      GIT_AUTHOR_NAME: bot.login,
      GIT_AUTHOR_EMAIL: bot.email,
      GIT_COMMITTER_NAME: bot.login,
      GIT_COMMITTER_EMAIL: bot.email,
    };
    const commit = await run(
      ["commit-tree", tree, "-p", baseSha, "-m", "chore(towercab): add verifying checks"],
      who,
    );
    const changed = (await run(["diff-tree", "--no-commit-id", "--name-only", "-r", baseSha, commit], base))
      .split("\n")
      .filter(Boolean);
    if (changed.length !== 1 || changed[0] !== "CLAUDE.md") {
      throw new Error(`the setup PR may change only CLAUDE.md, not: ${changed.join(", ")}`);
    }
    return commit;
  } finally {
    rmSync(index, { force: true });
  }
}

async function pushPhase(d: SetupDeps, repo: RepoConfig, rec: SetupRecord): Promise<SetupRecord> {
  const clone = clonePath(repo, d.home.root);
  const branch = setupBranch(repo.name);
  await fetchBase(d, repo, clone);
  const commit = await commitClaude(d, repo, rec, clone);
  const auth = await d.github.gitAuth(repo.github);
  await git(d.tools, clone, ["push", "--force", "origin", `${commit}:refs/heads/${branch}`], auth);
  let pr = await d.github.openPrOn(repo.github, branch);
  if (!pr) {
    const created =
      (await git(d.tools, clone, ["ls-tree", `refs/remotes/origin/${repo.base}`, "CLAUDE.md"])).trim() === "";
    pr = await d.github.openPr(repo.github, {
      base: repo.base,
      head: branch,
      title: "chore(towercab): add verifying checks",
      body: draftPrBody(rec.draft!, { base: repo.base, created, output: rec.output ?? "" }),
    });
  }
  if (!pr) throw new Error("GitHub gave no pull request number");
  d.log(`${repo.name}: opened the setup PR #${pr}`);
  return { ...rec, state: "open", branch, pr, head: commit, pushedAt: d.clock.now() };
}

// -- driving the PR like any other change --------------------------------------------------------------

/** The lowest effective autonomy among the intents waiting for this repo's checks; the owner merges with none. */
async function autonomyOf(d: SetupDeps, repo: RepoConfig): Promise<number> {
  const waiting = unfinished(d.db).filter((m) => m.repo === repo.name && m.waiting?.startsWith(WAIT_PREFIX));
  if (!waiting.length) return OWNER_MERGES;
  let cap = 5;
  try {
    const t = await d.github.readFile(repo.github, "TOWERCAB.md", repo.base);
    if (t !== null) cap = parseTowercab(t).maxAutonomy;
  } catch {
    cap = OWNER_MERGES;
  }
  const as: number[] = [];
  for (const m of waiting) {
    try {
      const i = await d.store.get(m.intent);
      as.push(effectiveA(levelNow(d.db, i), cap, i.source));
    } catch {
      as.push(OWNER_MERGES);
    }
  }
  return Math.min(...as);
}

/** The review of the setup PR (REPO-36): only CLAUDE.md, only checks, and they pass on the base branch. */
export async function reviewSetupPr(
  d: SetupDeps,
  repo: RepoConfig,
  pr: number,
  head: string,
): Promise<string[]> {
  const finds: string[] = [];
  const files = (await d.github.prFiles(repo.github, pr)).map((f) => f.filename);
  const others = files.filter((f) => f !== "CLAUDE.md");
  if (others.length || !files.includes("CLAUDE.md")) {
    finds.push(`The PR must change only \`CLAUDE.md\`; it changes ${files.join(", ") || "nothing"}.`);
  }
  const text = await d.github.readFile(repo.github, "CLAUDE.md", head);
  if (text === null) return [...finds, "`CLAUDE.md` is not on the PR's branch."];
  let v: ReturnType<typeof parseVerifying>;
  try {
    v = parseVerifying(text);
  } catch (e) {
    return [...finds, `\`CLAUDE.md\` has no usable checks block: ${(e as Error).message}.`];
  }
  if (v.fast !== null || v.screenshots !== null) {
    finds.push("The PR adds a `fast` or `screenshots` block; a setup PR adds only `setup` and `checks`.");
  }
  for (const [block, lines] of [
    ["setup", v.setup],
    ["checks", v.checks],
  ] as const) {
    for (const l of lines) {
      if (!commandIsCheckOnly(l, block)) {
        finds.push(
          `\`${l.length > 80 ? `${l.slice(0, 77)}…` : l}\` in the ${block} block could deploy, publish, write over the network, use a secret or needs the network to check: the checks may only verify.`,
        );
      }
    }
  }
  if (finds.length) return finds;
  const clone = clonePath(repo, d.home.root);
  const scratch = join(d.home.root, "setup", `${repo.name}-review`);
  try {
    await fetchBase(d, repo, clone);
    await exportTree(d, clone, `refs/remotes/origin/${repo.base}`, scratch);
    const ran = await runDraft(d, repo, scratch, v.setup, v.checks);
    if (!ran.ok) finds.push(`The drafted checks don't pass on \`${repo.base}\`: ${ran.why}.`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return finds;
}

async function drivePr(d: SetupDeps, repo: RepoConfig, rec: SetupRecord): Promise<SetupRecord> {
  const pr = rec.pr!;
  const now = d.clock.now();
  if (rec.polledAt !== undefined && now - rec.polledAt < POLL_S) return rec;
  const next: SetupRecord = { ...rec, polledAt: now };
  const st = await d.github.mergeStatus(repo.github, pr);
  if (st.state === "MERGED") return { ...next, state: "merged" };
  if (st.state === "CLOSED") return { ...next, state: "closed" };
  const head = st.head;
  if (next.blockedHead === head) return next;
  if (next.reviewedHead !== head) {
    const finds = await reviewSetupPr(d, repo, pr, head);
    if (finds.length) {
      await d.github.commentOnPr(
        repo.github,
        pr,
        `**Setup review: blocking.** Towercab will not merge this PR itself.\n\n${finds.map((f) => `- ${f}`).join("\n")}`,
      );
      return { ...next, blockedHead: head };
    }
    await d.github.commentOnPr(
      repo.github,
      pr,
      `**Setup review: approved.** Only \`CLAUDE.md\` changes, every command only verifies, and the checks pass on \`${repo.base}\`.`,
    );
    next.reviewedHead = head;
  }
  const read = await d.github.readChecks(repo.github, pr);
  const b = bucket(read.checks, rec.pushedAt ?? 0, now, CI_GRACE_S);
  if (b.kind === "pending") return next;
  const g = gate({
    a: await autonomyOf(d, repo),
    ciGreen: b.kind === "green" || b.kind === "none",
    review: { approved: true },
    unplanned: false,
    proven: true,
    risk: "low",
  });
  if (!g.merge) {
    if (next.heldHead !== head) {
      await d.github.commentOnPr(repo.github, pr, `Waiting for you to merge this: ${g.why}`);
      next.heldHead = head;
    }
    return next;
  }
  const r = await d.github.mergePr(repo.github, pr, { method: MERGE_METHOD, head });
  if (!r.ok) d.log(`${repo.name}: couldn't merge the setup PR #${pr}: ${r.reason}`);
  return next;
}

// -- the job -------------------------------------------------------------------------------------------

/** Errors in a row (a failed fetch, an auth fault) before a setup gives up and the owner is asked. */
export const MAX_ERRORS = 3;
/** Back-off after an error, per error in a row (s). */
const RETRY_S = 30;

/** Does this record need a step now? An open PR is read at most every `POLL_S`; an error backs off. */
function due(rec: SetupRecord, now: number): boolean {
  if (rec.state === "drafting" || rec.state === "pushing")
    return rec.retryAt === undefined || now >= rec.retryAt;
  if (rec.state === "open") return rec.polledAt === undefined || now - rec.polledAt >= POLL_S;
  return false;
}

/** Is there a setup that needs a step now? */
export function setupWork(db: Db, config: Config, now: number): boolean {
  for (const repo of config.repos.values()) {
    const rec = getSetup(db, repo.name);
    if (rec && due(rec, now)) return true;
  }
  return false;
}

/**
 * One step of the first repo whose setup is due; true when a repo was worked on. A repo that isn't due (a PR
 * read a moment ago, an error backing off) never holds up the repos after it.
 */
export async function setupChecksPass(d: SetupDeps): Promise<boolean> {
  for (const repo of d.config.repos.values()) {
    if (isGitlab(repo.github)) continue;
    const rec = getSetup(d.db, repo.name);
    if (!rec || !due(rec, d.clock.now())) continue;
    try {
      let next: SetupRecord = rec;
      if (rec.state === "drafting") {
        next = await draftPhase(d, repo, rec);
        // The record is stored before the push, so a crash never opens a second PR (the branch is adopted).
        putSetup(d.db, repo.name, next);
      }
      if (next.state === "pushing") next = await pushPhase(d, repo, next);
      else if (next.state === "open") next = await drivePr(d, repo, next);
      putSetup(d.db, repo.name, { ...next, errors: 0, retryAt: undefined });
    } catch (e) {
      const msg = (e as Error).message;
      d.log(`setting up checks for ${repo.name}: ${msg}`);
      const cur = getSetup(d.db, repo.name) ?? rec;
      const now = d.clock.now();
      if (cur.state === "open") {
        // An unreadable PR is looked at again at the next poll, not on every pass.
        putSetup(d.db, repo.name, { ...cur, polledAt: now });
      } else {
        const errors = (cur.errors ?? 0) + 1;
        // Repeated errors end the setup, so the owner is asked instead of the intents waiting without a reason.
        putSetup(
          d.db,
          repo.name,
          errors >= MAX_ERRORS
            ? { ...cur, state: "failed", errors, lastFailure: `${msg}`, retryAt: undefined }
            : { ...cur, errors, retryAt: now + RETRY_S * errors },
        );
      }
    }
    return true;
  }
  return false;
}

/** Missions waiting for a setup PR whose record has ended (or is gone): they carry on without a reply. */
export function resumable(db: Db): Mission[] {
  return unfinished(db).filter((m) => {
    if (m.stage !== "blocked" || !m.waiting?.startsWith(WAIT_PREFIX)) return false;
    const rec = getSetup(db, m.repo);
    return rec === null || ["merged", "closed", "failed"].includes(rec.state);
  });
}

/** After the waiters are resumed: a merged record has done its work. */
export function dropMerged(db: Db, config: Config): void {
  for (const repo of config.repos.keys()) {
    if (getSetup(db, repo)?.state === "merged") dropSetup(db, repo);
  }
}
