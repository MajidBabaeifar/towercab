// Secret steps (SHIP-33..36): Towercab writes a secret into a SOPS file of another repo through a pull
// request the owner approves. The value is made (SHIP-34) or typed (SHIP-35) in this process only: it
// reaches `sops` on stdin, never an argument, a log, a PR, the database or the worker.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ensureClone, git } from "../checkout.ts";
import { tickSteps } from "../commands.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import type { Clock, GitHub } from "../handlers.ts";
import type { Home } from "../home.ts";
import { dataOf, getMission, type Mission, patchData, unfinishedFor } from "../mission.ts";
import type { SecretState } from "../pipeline/common.ts";
import { type OwnerStep, type SecretSpec, unticked } from "../steps.ts";
import { check, type Tools } from "../tools.ts";
import { generateSecret } from "./generate.ts";
import { REDACTED } from "./secrets.ts";

/** What the secret work needs; the loop's `Ctx` has all of it. */
export interface SecretEnv {
  db: Db;
  tools: Tools;
  github: GitHub;
  config: Config;
  home: Home;
  clock: Clock;
  log(line: string): void;
}

/** SHIP-34: failures in a row after which Towercab stops trying by itself. */
export const MAX_FAILS = 3;
/** SHIP-35: the longest value the page takes, in bytes. */
export const MAX_VALUE = 8192;

/** SHIP-36: the text with every occurrence of `value` (and its JSON form) replaced. */
export function mask(text: string, value: string | null): string {
  if (!value) return text;
  return text.split(value).join(REDACTED).split(JSON.stringify(value).slice(1, -1)).join(REDACTED);
}

/** Whether the encrypted file has `key` at its top level; the key names of a SOPS file are plain text. */
export function hasKey(text: string, file: string, key: string): boolean {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (/\.json$/i.test(file)) return new RegExp(`"${k}"\\s*:`).test(text);
  if (/\.(env|ini)$/i.test(file)) return new RegExp(`^${k}\\s*=`, "m").test(text);
  return new RegExp(`^${k}\\s*:`, "m").test(text);
}

let chain: Promise<unknown> = Promise.resolve();
/** One secret write at a time: the page and the loop share one clone per repo. */
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const r = chain.then(fn, fn);
  chain = r.catch(() => {});
  return r;
}

const stateOf = (m: Mission, n: number): SecretState =>
  (dataOf<{ secrets?: Record<string, SecretState> }>(m).secrets ?? {})[String(n)] ?? {};

/** Merge `patch` into step `n`'s state, or clear it (null), in one transaction. */
function setState(db: Db, clock: Clock, id: number, n: number, patch: SecretState | null): void {
  db.tx(() => {
    const cur = getMission(db, id);
    if (!cur) return;
    const all = { ...(dataOf<{ secrets?: Record<string, SecretState> }>(cur).secrets ?? {}) };
    if (patch === null) delete all[String(n)];
    else all[String(n)] = { ...all[String(n)], ...patch };
    // Undefined values are dropped by JSON; a key cleared on purpose is set to undefined.
    patchData(db, cur, { secrets: Object.keys(all).length ? all : undefined }, clock.now());
  });
}

interface Clone {
  dir: string;
  github: string;
  base: string;
  text: string;
}

/** A clean clone of the repo's default branch, with the target file read. */
async function cloneOf(env: SecretEnv, spec: SecretSpec): Promise<Clone> {
  const repo = env.config.repos.get(spec.repo);
  if (!repo) throw new Error(`unknown repo ${spec.repo}`);
  const auth = await env.github.gitAuth(repo.github);
  const dir = join(env.home.root, "secrets", repo.name);
  await ensureClone(env.tools, dir, repo, auth);
  await git(env.tools, dir, ["checkout", "--quiet", "--force", "-B", "towercab-base", `origin/${repo.base}`]);
  await git(env.tools, dir, ["clean", "-fdq"]);
  const path = resolve(dir, spec.file);
  if (!path.startsWith(dir + sep)) throw new Error(`${spec.file} is outside ${spec.repo}`);
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  return { dir, github: repo.github, base: repo.base, text };
}

const branchOf = (intent: string, key: string) =>
  `towercab/secret-${intent}-${key.replace(/[^A-Za-z0-9_-]/g, "-")}`;

function prBody(intent: string, spec: SecretSpec): string {
  return [
    "## What this does",
    "",
    `Adds \`${spec.key}\` to \`${spec.file}\`, encrypted with sops. It is for: ${spec.purpose || "the change that needs it"}.`,
    "",
    "## Why",
    "",
    `Intent ${intent} needs this secret, and Towercab ${spec.source === "generate" ? "made up its value" : "took the value you typed"}.`,
    "",
    "## What to check before merging",
    "",
    "The value is not shown anywhere, here or in Towercab. Approve it in Towercab to merge this pull request.",
    "",
  ].join("\n");
}

/**
 * Write `value` as `spec.key` of `spec.file` on a branch and open the PR as the App; returns its number,
 * or null when the key is already there (an existing value is never replaced).
 */
async function writeSecret(
  env: SecretEnv,
  intent: string,
  spec: SecretSpec,
  value: string,
): Promise<{ pr: number; branch: string } | null> {
  return exclusive(async () => {
    try {
      const c = await cloneOf(env, spec);
      if (hasKey(c.text, spec.file, spec.key)) return null;
      const branch = branchOf(intent, spec.key);
      await git(env.tools, c.dir, ["checkout", "--quiet", "--force", "-B", branch, `origin/${c.base}`]);
      const r = await env.tools.run("sops", ["set", "--value-stdin", spec.file, JSON.stringify([spec.key])], {
        cwd: c.dir,
        input: JSON.stringify(value),
        timeoutMs: 60_000,
      });
      if (r.code !== 0 && /flag provided but not defined|unknown flag|value-stdin/i.test(r.stderr))
        throw new Error("this sops can't read a value from stdin; install a newer sops");
      check(r, "sops set");
      if (!hasKey(readFileSync(join(c.dir, spec.file), "utf8"), spec.file, spec.key))
        throw new Error(`sops didn't add ${spec.key} to ${spec.file}`);
      const auth = await env.github.gitAuth(c.github);
      const bot = await env.github.bot();
      await git(env.tools, c.dir, ["add", "--", spec.file]);
      await git(env.tools, c.dir, [
        "-c",
        `user.name=${bot.login}`,
        "-c",
        `user.email=${bot.email}`,
        "commit",
        "--quiet",
        "-m",
        `chore(secrets): add ${spec.key} to ${spec.file}`,
      ]);
      await git(
        env.tools,
        c.dir,
        ["push", "--quiet", "--force", "origin", `HEAD:refs/heads/${branch}`],
        auth,
      );
      const found = await env.github.gh(c.github, [
        "pr",
        "list",
        "-R",
        c.github,
        "--head",
        branch,
        "--state",
        "open",
        "--json",
        "number",
        "--jq",
        ".[0].number",
      ]);
      let pr = Number(found.stdout.trim());
      if (found.code !== 0 || !Number.isInteger(pr) || pr < 1) {
        const made = check(
          await env.github.gh(
            c.github,
            [
              "pr",
              "create",
              "-R",
              c.github,
              "--base",
              c.base,
              "--head",
              branch,
              "--title",
              `chore(secrets): add ${spec.key} to ${spec.file}`,
              "--body-file",
              "-",
            ],
            { input: prBody(intent, spec) },
          ),
          "gh pr create",
        );
        pr = Number(/\/pull\/(\d+)/.exec(made)?.[1]);
        if (!Number.isInteger(pr) || pr < 1) throw new Error("GitHub gave no pull request number");
      }
      return { pr, branch };
    } catch (e) {
      throw new Error(mask((e as Error).message, value));
    }
  });
}

/** SHIP-35: the owner typed a value for a supplied secret; write it and wait for their approval. */
export async function supplySecret(env: SecretEnv, intent: string, n: number, raw: string): Promise<string> {
  const m = unfinishedFor(env.db, intent);
  const steps = dataOf<{ steps?: OwnerStep[] }>(m ?? ({ data: "{}" } as Mission)).steps ?? [];
  const step = steps.find((s) => s.n === n);
  if (!m || !step) throw new Error(`step ${n} isn't one of ${intent}'s steps`);
  if (step.secret?.source !== "supply") throw new Error(`step ${n} has no secret field`);
  if (step.done_at) throw new Error(`${step.secret.key} is already in ${step.secret.file}`);
  const value = raw.replace(/[\r\n]+$/, "");
  if (!value) throw new Error(`${step.secret.key} needs a value`);
  if (Buffer.byteLength(value) > MAX_VALUE) throw new Error(`${step.secret.key} is too long`);
  let done: { pr: number; branch: string } | null;
  try {
    done = await writeSecret(env, intent, step.secret, value);
  } catch (e) {
    env.log(`${intent}: couldn't write ${step.secret.key}: ${(e as Error).message}`);
    throw new Error(`Couldn't write ${step.secret.key}: ${(e as Error).message}`);
  }
  if (!done) return `${step.secret.key} is already in ${step.secret.file}; Towercab ticks the step.`;
  setState(env.db, env.clock, m.id, n, { ...done, approved: false, fails: 0, error: undefined });
  return `Saved ${step.secret.key} in a pull request. Approve it to merge.`;
}

/** SHIP-34: the owner approves a secret's PR (or, after repeated failures, asks to try again). */
export function approveSecret(db: Db, clock: Clock, intent: string, n: number): string {
  const m = unfinishedFor(db, intent);
  const step = (dataOf<{ steps?: OwnerStep[] }>(m ?? ({ data: "{}" } as Mission)).steps ?? []).find(
    (s) => s.n === n,
  );
  if (!m || !step) throw new Error(`step ${n} isn't one of ${intent}'s steps`);
  if (!step.secret) throw new Error(`step ${n} has no secret`);
  const st = stateOf(m, n);
  if (st.pr) {
    setState(db, clock, m.id, n, { approved: true, fails: 0, error: undefined });
    return `Approved; Towercab merges the pull request for ${step.secret.key} on its next pass.`;
  }
  if ((st.fails ?? 0) > 0) {
    setState(db, clock, m.id, n, { fails: 0, error: undefined });
    return `Trying ${step.secret.key} again on the next pass.`;
  }
  throw new Error(`${step.secret.key} has no pull request to approve yet`);
}

/** SHIP-34: what a pass does for one secret step. */
async function advanceOne(env: SecretEnv, m: Mission, s: OwnerStep & { secret: SecretSpec }): Promise<void> {
  const st = stateOf(m, s.n);
  if ((st.fails ?? 0) >= MAX_FAILS) return;
  const key = `${s.secret.key} in ${s.secret.file}`;
  try {
    const c = await exclusive(() => cloneOf(env, s.secret));
    if (hasKey(c.text, s.secret.file, s.secret.key)) {
      tickSteps(env.db, m.intent, [s.n], true, new Date(env.clock.now() * 1000), true);
      setState(env.db, env.clock, m.id, s.n, null);
      env.log(`${m.intent}: ${key} exists, ticked step ${s.n}`);
      return;
    }
    if (st.pr) {
      const v = await env.github.gh(c.github, [
        "pr",
        "view",
        String(st.pr),
        "-R",
        c.github,
        "--json",
        "state",
      ]);
      const state = (JSON.parse(check(v, "gh pr view")) as { state?: string }).state;
      if (state === "CLOSED") {
        setState(env.db, env.clock, m.id, s.n, null);
        env.log(`${m.intent}: the pull request for ${key} was closed; starting over`);
      } else if (state === "OPEN" && st.approved) {
        check(
          await env.github.gh(c.github, ["pr", "merge", String(st.pr), "-R", c.github, "--squash"]),
          "gh pr merge",
        );
        env.log(`${m.intent}: merged the pull request for ${key}`);
      }
      return;
    }
    if (s.secret.source !== "generate") return;
    const value = generateSecret(s.secret.length, s.secret.alphabet);
    const done = await writeSecret(env, m.intent, s.secret, value);
    if (done) {
      setState(env.db, env.clock, m.id, s.n, { ...done, approved: false, fails: 0, error: undefined });
      env.log(`${m.intent}: opened pull request #${done.pr} for ${key}`);
    }
  } catch (e) {
    const fails = (st.fails ?? 0) + 1;
    const why = (e as Error).message.split("\n")[0]!;
    setState(env.db, env.clock, m.id, s.n, { fails, error: why });
    env.log(
      `${m.intent}: ${key} failed (${fails} of ${MAX_FAILS}): ${why}${fails >= MAX_FAILS ? "; not trying again until you do" : ""}`,
    );
  }
}

/** SHIP-34, SHIP-35: once per pass, move the secret steps the mission waits on one step on. */
export async function advanceSecrets(env: SecretEnv, m: Mission): Promise<void> {
  const when =
    m.stage === "blocked" && m.waiting === "your steps first"
      ? "before"
      : m.stage === "steps" && m.waiting === "your steps"
        ? "after"
        : null;
  if (!when) return;
  const steps = dataOf<{ steps?: OwnerStep[] }>(m).steps;
  for (const s of unticked(steps, when)) {
    if (!s.secret) continue;
    const cur = getMission(env.db, m.id);
    if (cur) await advanceOne(env, cur, s as OwnerStep & { secret: SecretSpec });
  }
}
