// The setup of a repo that has setup secrets (PIP-211..214): pass 1 runs the repo's setup lines with the
// secrets in a clean export of the base commit's tree, with system tools only; its install output is searched
// for the tokens and, if clean, copied into the checkout; pass 2 (only when the branch changed a manifest or
// lockfile) runs the same lines in the checkout with no secret at all.

import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { git } from "../checkout.ts";
import type { ChildEnd, Ctx, Progress } from "../handlers.ts";
import { type Outcome, wait } from "../machine.ts";
import type { Mission } from "../mission.ts";
import type { Tools } from "../tools.ts";
import { type SandboxRun, sandboxSpec } from "./checks.ts";
import { data } from "./common.ts";
import type { Question } from "./schemas.ts";
import {
  credsEnv,
  type Hit,
  MAX_CACHE_SCAN,
  manifestChanges,
  readSetupSecrets,
  redactSetup,
  refusedHost,
  SCRIPTS_OFF,
  type SetupSecrets,
  SetupSecretsError,
  scanDir,
  scanGitFiles,
  setupSecretsPath,
  systemPath,
  unsupportedTool,
} from "./setup-secrets.ts";

/** The clean export of the base tree and the credentials folder of the pass for `dir` (PIP-212, PIP-214). */
export const setupTreeOf = (dir: string): string => `${dir}-setup-tree`;
export const setupCredsOf = (dir: string): string => `${dir}-setup-creds`;
const setupCacheOf = (dir: string): string => `${dir}-setup-cache`;

/** Removes the cache pass 2 used. */
export function dropOpenCache(dir: string): void {
  rmSync(setupCacheOf(dir), { recursive: true, force: true });
}
const indexOf = (dir: string): string => `${dir}-setup-index`;

export interface PassOpts {
  kind: SandboxRun["kind"];
  /** The checkout the setup is for. */
  dir: string;
  lines: string[];
  /** The log file (stdout); the pass's stderr is `<log>.err`. */
  log: string;
  timeoutMs: number;
}

const read = (p: string): string => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};

const gitIn = (tools: Tools, dir: string, args: string[], env: Record<string, string> = {}) =>
  git(tools, dir, args, { args: [], env });

/** The commit the branch started from: where it meets the base branch. Without it the stage stops. */
async function baseCommit(cx: Ctx, m: Mission, dir: string): Promise<string | null> {
  const ref = `refs/remotes/origin/${cx.repo(m).base}`;
  try {
    return (await gitIn(cx.tools, dir, ["merge-base", "HEAD", ref])).trim() || null;
  } catch {
    return null;
  }
}

/** The secrets each running pass was started with, by checkout: redaction uses them, not the file as it is later. */
const started = new Map<string, SetupSecrets>();

/** True while a secret pass of the checkout `dir` has started and not yet been read. */
export const secretPassRan = (dir: string): boolean => started.has(dir);

function merged(a: SetupSecrets | null, b: SetupSecrets | null): SetupSecrets | null {
  if (!a || !b) return a ?? b;
  return {
    env: { ...a.env, ...b.env },
    tokens: [...a.tokens, ...b.tokens],
    pairs: [...a.pairs, ...b.pairs],
  };
}

/** A fresh export of `base`'s tree into `tree`: no `.git`, no ignored folder, nothing a worker wrote. */
export async function exportTree(tools: Tools, dir: string, base: string, tree: string): Promise<void> {
  const index = indexOf(dir);
  rmSync(index, { force: true });
  // The index stays until the pass is done: it is what main tracks, so what `copyOut` calls new is new.
  await gitIn(tools, dir, ["read-tree", base], { GIT_INDEX_FILE: index });
  await gitIn(tools, dir, ["checkout-index", "-a", "-f", `--prefix=${tree}/`], { GIT_INDEX_FILE: index });
}

/** The secrets of the mission's repo; null → none. A bad file is a wait on `fix repo files`. */
function load(cx: Ctx, m: Mission): SetupSecrets | null | { done: Outcome } {
  try {
    return readSetupSecrets(setupSecretsPath(cx.config.file, m.repo));
  } catch (e) {
    if (e instanceof SetupSecretsError) return { done: wait("fix repo files", e.message) };
    throw e;
  }
}

/**
 * Pass 1 (PIP-214): null when the repo has no setup secrets file (the caller runs setup as before). The caller
 * has recorded the step this pass runs in.
 */
export async function startSecretPass(cx: Ctx, m: Mission, o: PassOpts): Promise<Progress | null> {
  const secrets = load(cx, m);
  if (!secrets) return null;
  if ("done" in secrets) return secrets;
  const tool = unsupportedTool(o.lines);
  if (tool)
    return {
      done: wait(
        "fix repo files",
        `setup secrets cannot be used with ${tool}: its install scripts cannot be turned off`,
      ),
    };
  const base = await baseCommit(cx, m, o.dir);
  if (!base)
    return {
      done: wait(
        "fix repo files",
        `setup secrets need the commit where the branch left ${cx.repo(m).base}, and Towercab couldn't find it`,
      ),
    };
  started.set(o.dir, secrets);
  const at = cx.record(m, m.step, {}, { setupSecret: { start: Date.now() - 2000, base } });
  const tree = setupTreeOf(o.dir);
  const creds = setupCredsOf(o.dir);
  rmSync(tree, { recursive: true, force: true });
  rmSync(creds, { recursive: true, force: true });
  mkdirSync(tree, { recursive: true });
  mkdirSync(creds, { recursive: true, mode: 0o700 });
  await exportTree(cx.tools, o.dir, base, tree);
  return {
    spawn: sandboxSpec(cx, at, {
      kind: o.kind,
      lines: o.lines,
      dir: o.dir,
      cacheWritable: true,
      log: o.log,
      timeoutMs: o.timeoutMs,
      tree,
      extraBinds: [creds],
      // Last wins: the secrets, then what Towercab fixes (a secret can't name these, PIP-211).
      extraEnv: {
        ...secrets.env,
        PATH: systemPath(homedir(), o.dir, tree),
        ...credsEnv(creds),
        ...SCRIPTS_OFF,
      },
    }),
  };
}

export type PassEnd =
  | { done: Outcome }
  | {
      /** The pass's output with every setup secret replaced. */
      log: string;
      /** The pass failed or timed out; nothing was copied. */
      failed: boolean;
      /** Manifests and lockfiles the branch changed: pass 2 is due when not empty. */
      open: string[];
    };

/** Clears the setuid and setgid bits of everything under `path` (links are left alone). */
function clearSetid(path: string): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) return;
  if (st.mode & 0o6000) chmodSync(path, st.mode & 0o1777);
  if (st.isDirectory()) for (const e of readdirSync(path)) clearSetid(join(path, e));
}

/** True when every parent folder of `rel` under `root` is a real folder (or does not exist yet). */
function plainParents(root: string, rel: string): boolean {
  let at = root;
  for (const part of rel.split("/").slice(0, -1)) {
    at = join(at, part);
    try {
      if (!lstatSync(at).isDirectory()) return false;
    } catch {
      return true;
    }
  }
  return true;
}

/**
 * Copies what main's `.gitignore` ignores from the clean tree into the checkout (PIP-214), never over a
 * tracked file; returns the new files that were left out.
 */
export async function copyOut(tools: Tools, dir: string, tree: string): Promise<string[]> {
  const env = { GIT_DIR: join(dir, ".git"), GIT_WORK_TREE: tree, GIT_INDEX_FILE: indexOf(dir) };
  const ignored = (
    await gitIn(tools, tree, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"], env)
  )
    .split("\n")
    .map((l) => l.replace(/\/$/, ""))
    .filter((l) => l && !l.startsWith(".git/") && l !== ".git");
  for (const p of ignored) {
    // A parent that is a link could lead outside the checkout (or the tree): such a path is left out.
    if (!plainParents(dir, p) || !plainParents(tree, p)) continue;
    const tracked = (await gitIn(tools, dir, ["ls-files", "--", p])).trim();
    if (tracked) continue;
    rmSync(join(dir, p), { recursive: true, force: true });
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    cpSync(join(tree, p), join(dir, p), { recursive: true, verbatimSymlinks: true });
    clearSetid(join(dir, p));
  }
  const left = (await gitIn(tools, tree, ["ls-files", "--others", "--exclude-standard"], env))
    .split("\n")
    .filter(Boolean);
  return left;
}

function hitOf(h: Hit): { done: Outcome } {
  return { done: wait("fix repo files", `setup left a secret in ${h.path} (${h.key})`) };
}

/**
 * Pass 1 ended (PIP-212, PIP-213): redact its log, search for the tokens, and only when clean copy the install
 * output into the checkout. A hit stops the stage; the worker never starts.
 */
export async function endSecretPass(cx: Ctx, m: Mission, end: ChildEnd, dir: string): Promise<PassEnd> {
  const now = load(cx, m);
  // The values the pass was given count, whatever the file holds now (it may have been rotated or removed).
  const ran = started.get(dir) ?? null;
  started.delete(dir);
  const secrets = merged(ran, now && !("done" in now) ? now : null);
  const raw = `${read(end.stdout)}${read(end.stderr)}`;
  if (!secrets) {
    // Nothing known to redact with: the output stays unread by the worker.
    writeFileSync(end.stdout, "");
    rmSync(end.stderr, { force: true });
    rmSync(setupTreeOf(dir), { recursive: true, force: true });
    rmSync(setupCredsOf(dir), { recursive: true, force: true });
    return now && "done" in now ? now : { log: "", failed: end.code !== 0, open: [] };
  }
  const tree = setupTreeOf(dir);
  const creds = setupCredsOf(dir);
  const sd = data(m).setupSecret;
  const cleanup = () => {
    rmSync(tree, { recursive: true, force: true });
    rmSync(creds, { recursive: true, force: true });
    rmSync(indexOf(dir), { force: true });
  };
  let log = redactSetup(secrets, raw);
  const keep = () => {
    writeFileSync(end.stdout, log);
    rmSync(end.stderr, { force: true });
  };
  keep();
  const cache = cx.home.cache(cx.repo(m).name);
  const start = sd?.start ?? 0;
  const hit =
    scanDir(tree, "", secrets) ??
    scanDir(creds, "setup-creds", secrets) ??
    scanGitFiles(dir, secrets) ??
    scanDir(cache, "cache", secrets, { want: (size, mtime) => size <= MAX_CACHE_SCAN && mtime >= start }) ??
    scanDir(dir, "", secrets, { skip: [".git"] });
  if (hit) {
    cleanup();
    return hitOf(hit);
  }
  const failed = end.code !== 0 || end.timedOut;
  let open: string[] = [];
  if (!failed) {
    const left = await copyOut(cx.tools, dir, tree);
    if (left.length) {
      log += `\nsetup left files that are not ignored, so they were not copied: ${left.slice(0, 20).join(", ")}\n`;
      keep();
    }
    const changed = (await gitIn(cx.tools, dir, ["diff", "--name-only", sd?.base ?? "HEAD"]))
      .split("\n")
      .filter(Boolean);
    open = manifestChanges(changed);
  }
  cleanup();
  return { log, failed, open };
}

/** Pass 2 (PIP-214): the same lines in the checkout with no secret, no credentials folder, built-in registries only. */
export function openPass(cx: Ctx, m: Mission, o: PassOpts): Progress {
  // Branch code runs here, so it gets a cache of its own: the shared one, which the secret pass reads, stays untouched.
  const cache = setupCacheOf(o.dir);
  rmSync(cache, { recursive: true, force: true });
  mkdirSync(cache, { recursive: true });
  return {
    spawn: sandboxSpec(cx, m, {
      kind: o.kind,
      lines: o.lines,
      dir: o.dir,
      cacheWritable: true,
      log: o.log,
      timeoutMs: o.timeoutMs,
      builtinOnly: true,
      cache,
    }),
  };
}

/** The question when pass 2 needs a private package (PIP-214). */
export function privateQuestion(changed: string[], log: string): Question {
  const host = refusedHost(log);
  const files = changed.map((f) => `\`${f}\``).join(", ");
  return {
    context: `The change edits ${files}. Towercab installed what the main branch lists with the registry token, and installs the rest without any token, so a change can't run its own code next to it. That second install was refused${host ? ` by ${host}` : ""}, so it needs something private.`,
    question:
      "The change updates packages that need the private registry. Add them on the main branch first, or change the manifests to public packages?",
    options: [
      {
        option: "I added them on the main branch",
        // biome-ignore lint/suspicious/noThenProperty: the question schema's key; never awaited.
        then: "Towercab runs the setup again from the start.",
        do: "continue",
      },
      {
        option: "Use public packages instead",
        // biome-ignore lint/suspicious/noThenProperty: the question schema's key; never awaited.
        then: "The worker changes the manifests to public packages and the checks run again.",
        do: "continue",
      },
    ],
    recommendation:
      "Add them on the main branch first: the token is only ever used for what main already lists.",
  };
}
