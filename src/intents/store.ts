// The intent store (INT-1, INT-4, INT-10, INT-11, INT-12): reads pull first; writes pull, change
// files, regenerate `TODO.md` and `DONE.md`, commit and push to `main`, and replay the change on a
// fresh `main` when the push is rejected.

import {
  closeSync,
  type Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { alive } from "../home.ts";
import { emit } from "../log.ts";
import { cmpIntents } from "../priority.ts";
import { GIT_TIMEOUT_MS, type RunResult, type Tools } from "../tools.ts";
import { featuresPath, isRepoName } from "./features.ts";
import { cmpIds, dirId, isId, newId, resolve, slugOf, splitDir } from "./id.ts";
import { formatValue, IntentFile, localTime } from "./intent.ts";
import {
  type Intent,
  type IntentEdit,
  type IntentStore,
  type Listing,
  type NewIntent,
  RefusedError,
  SyncError,
  type Unreadable,
} from "./types.ts";
import { doneView, todoView } from "./views.ts";

/** Old `DONE.md` lines, kept from v1's task list. */
export const LEGACY = "done/legacy.md";
/** Retries after the first rejected push. */
export const PUSH_RETRIES = 3;
/** The generated views: a rebase conflict only in them takes `main`'s side. */
export const VIEWS = ["TODO.md", "DONE.md"];
/** How long a store call waits for another process's lock. */
export const LOCK_WAIT_MS = 120_000;

/** Repository-selecting variables a caller's environment may carry. */
const REPO_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
];

export type GitAuth = () => Promise<{ args: string[]; env: Record<string, string> }>;

export interface StoreOptions {
  /** `[intents].remote`; empty → an existing checkout only. */
  remote: string;
  /** `[intents].path`. */
  path: string;
  tools: Tools;
  /** Network calls (clone, fetch, push) act as this returns (LOOP-19). */
  auth?: GitAuth;
  /** Commit author; default `towercab <towercab@localhost>`. */
  author?: { name: string; email: string };
  /** `[intents].cutoff` for `TODO.md` (default 7). */
  cutoff?: number;
  /** The clock for `finished` (default the system's). */
  now?: () => Date;
  /** Where dropped local commits are reported (default the log). */
  log?: (text: string) => void;
}

/** One read of the working tree. */
interface Scan {
  listing: Listing;
  files: Map<string, IntentFile>;
  legacy: string;
  /** Every folder's ID and every legacy one: never handed out again. */
  taken: Set<string>;
}

/** Whether some part of `rel` under `root` is a symlink; missing parts aren't. */
export function symlinkIn(root: string, rel: string): boolean {
  let p = root;
  for (const part of rel.split("/").filter(Boolean)) {
    p = join(p, part);
    try {
      if (lstatSync(p).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** IDs written as a whole word in `done/legacy.md`. */
export function legacyIds(text: string): Set<string> {
  return new Set(text.split(/\s+/).filter(isId));
}

/**
 * A `Listing` from readable intents: in `done/` or `stage: done|dropped` → done (newest first), else
 * open (PRI-4 order); `doneIds` = done minus dropped, plus `done/legacy.md`'s IDs.
 */
export function listingOf(intents: Intent[], legacy = "", unreadable: Unreadable[] = []): Listing {
  const finished = (i: Intent) => i.done || i.stage === "done" || i.stage === "dropped";
  const open = intents.filter((i) => !finished(i)).sort(cmpIntents);
  const done = intents.filter(finished).sort((a, b) => cmpIds(b.id, a.id));
  const droppedIds = new Set(done.filter((i) => i.stage === "dropped").map((i) => i.id));
  const doneIds = new Set([
    ...legacyIds(legacy),
    ...done.filter((i) => i.stage !== "dropped").map((i) => i.id),
  ]);
  const bad = [...unreadable].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { open, done, unreadable: bad, doneIds, droppedIds, head: "" };
}

/** Reads `intents/` and `done/` under `root` (no git); symlinks are never followed (INT-1). */
export function scan(root: string): Scan {
  const unreadable: Unreadable[] = [];
  const bad = (path: string, reason: string) =>
    unreadable.push({ path, reason, id: dirId(path.split("/")[1] ?? "") });
  const folders: { base: string; name: string; link: boolean }[] = [];
  for (const base of ["intents", "done"]) {
    if (symlinkIn(root, base)) {
      unreadable.push({ path: base, reason: "symlink", id: null });
      continue;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(join(root, base), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.isDirectory() || e.isSymbolicLink())
        folders.push({ base, name: e.name, link: e.isSymbolicLink() });
    }
  }
  const count = new Map<string, number>();
  for (const f of folders) {
    const id = dirId(f.name);
    if (id) count.set(id, (count.get(id) ?? 0) + 1);
  }
  let legacy = "";
  if (symlinkIn(root, LEGACY)) unreadable.push({ path: LEGACY, reason: "symlink", id: null });
  else {
    try {
      legacy = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(join(root, LEGACY)));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") unreadable.push({ path: LEGACY, reason: code ?? "not UTF-8", id: null });
    }
  }
  const files = new Map<string, IntentFile>();
  const all: Intent[] = [];
  for (const { base, name, link } of folders) {
    const dir = `${base}/${name}`;
    if (link) {
      bad(dir, "symlink");
      continue;
    }
    const parts = splitDir(name);
    if (!parts) {
      bad(dir, "not an <id>-<slug> folder");
      continue;
    }
    if ((count.get(parts.id) ?? 0) > 1) {
      bad(dir, "duplicate id");
      continue;
    }
    const file = `${dir}/intent.md`;
    if (symlinkIn(root, file)) {
      bad(file, "symlink");
      continue;
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(join(root, file)));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") bad(dir, "no intent.md");
      else bad(file, code ?? "not UTF-8");
      continue;
    }
    try {
      const f = IntentFile.parse(text);
      [f.id, f.slug, f.dir] = [parts.id, parts.slug, dir];
      files.set(parts.id, f);
      all.push(f.intent);
    } catch (e) {
      bad(file, (e as Error).message);
    }
  }
  const taken = new Set([...count.keys(), ...legacyIds(legacy)]);
  return { listing: listingOf(all, legacy, unreadable), files, legacy, taken };
}

/**
 * An open intent by ID or suffix (INT-3, over open intents). An unreadable folder in `intents/` fails
 * with its reason (INT-11) when `s` is its exact ID, or when no open ID matches and it is the one
 * unreadable ID ending with `s`.
 */
export function findOpen(listing: Listing, s: string): Intent {
  const bad = listing.unreadable.filter((u) => u.path.startsWith("intents/") && u.id !== null);
  const refused = (u: Unreadable) => new RefusedError(`${u.path}: ${u.reason}`);
  const exact = listing.open.find((i) => i.id === s);
  if (exact) return exact;
  const b = bad.find((u) => u.id === s);
  if (b) throw refused(b);
  if (listing.open.some((i) => i.id.endsWith(s))) {
    const id = resolve(
      s,
      listing.open.map((i) => i.id),
    );
    return listing.open.find((i) => i.id === id)!;
  }
  const id = resolve(
    s,
    bad.map((u) => u.id!),
  );
  throw refused(bad.find((u) => u.id === id)!);
}

/** `owner/name` of an `https://github.com/<owner>/<name>[.git]` remote, else null. */
export function githubOf(remote: string): string | null {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remote);
  return m ? `${m[1]}/${m[2]}` : null;
}

const held = new Map<string, Promise<void>>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run `fn` holding `path` (one at a time in this process, then across processes by an exclusive file). */
async function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = held.get(path) ?? Promise.resolve();
  let release!: () => void;
  const tail = prev.then(() => new Promise<void>((r) => (release = r)));
  held.set(path, tail);
  await prev;
  try {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const fd = openSync(path, "wx", 0o600);
        writeSync(fd, `${process.pid}\n`);
        closeSync(fd);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST")
          throw new RefusedError(`${path}: ${(e as Error).message}`);
        let pid = 0;
        try {
          pid = Number(readFileSync(path, "utf8").trim());
        } catch {
          continue;
        }
        // A dead holder's lock (a killed run) is taken over; ours can't be held here.
        if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || !alive(pid)) {
          rmSync(path, { force: true });
          continue;
        }
        if (Date.now() > deadline) throw new RefusedError(`${path}: held by pid ${pid}`);
        await sleep(25);
      }
    }
    try {
      return await fn();
    } finally {
      rmSync(path, { force: true });
    }
  } finally {
    release();
    if (held.get(path) === tail) held.delete(path);
  }
}

const plainEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !REPO_ENV.includes(k)) env[k] = v;
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" };
};

/** The first line of a failed git call's output. */
function why(r: RunResult): string {
  return (
    (r.stderr || r.stdout)
      .trim()
      .split("\n")
      .find((l) => l.trim()) ?? `exit ${r.code}`
  ).trim();
}

/** `openStore`'s store: the intents repo's checkout on `main`, through the `git` CLI. */
export class GitStore implements IntentStore {
  readonly path: string;
  private o: StoreOptions;
  private gitDir = "";
  private origin = false;

  private constructor(o: StoreOptions) {
    this.o = o;
    this.path = o.path;
  }

  /** Open `path`, cloning `remote` there when missing; refuses a checkout off `main` (INT-4). */
  static async open(o: StoreOptions): Promise<GitStore> {
    const s = new GitStore(o);
    if (!existsSync(o.path)) {
      if (!o.remote) {
        throw new RefusedError(`intents: ${o.path} does not exist and [intents].remote is not set`);
      }
      mkdirSync(dirname(o.path), { recursive: true });
      const r = await s.git(["clone", "--quiet", "--", o.remote, o.path], {
        net: true,
        cwd: dirname(o.path),
      });
      if (r.code !== 0) throw new SyncError(`clone failed: ${why(r)}`);
    }
    const top = await s.git(["rev-parse", "--show-toplevel"]);
    let same = false;
    try {
      same = top.code === 0 && realpathSync(top.stdout.trim()) === realpathSync(o.path);
    } catch {
      same = false;
    }
    if (!same) throw new RefusedError(`intents: ${o.path} is not a git checkout`);
    s.gitDir = (await s.ok(["rev-parse", "--absolute-git-dir"])).trim();
    s.origin = (await s.git(["remote", "get-url", "origin"])).code === 0;
    await s.locked(async () => {
      await s.recover();
      await s.onMain();
    });
    return s;
  }

  private get cutoff(): number {
    return this.o.cutoff ?? 7;
  }

  private async git(args: string[], opts: { net?: boolean; cwd?: string } = {}): Promise<RunResult> {
    const author = this.o.author ?? { name: "towercab", email: "towercab@localhost" };
    const pre = [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "commit.gpgsign=false",
      "-c",
      `user.name=${author.name}`,
      "-c",
      `user.email=${author.email}`,
    ];
    let env = plainEnv();
    if (opts.net && this.o.auth) {
      const a = await this.o.auth();
      pre.push(...a.args);
      env = { ...env, ...a.env };
    }
    return this.o.tools.run("git", [...pre, ...args], {
      cwd: opts.cwd ?? this.path,
      env,
      timeoutMs: GIT_TIMEOUT_MS,
    });
  }

  /** stdout, or a `RefusedError` with git's reason. */
  private async ok(args: string[], net = false): Promise<string> {
    const r = await this.git(args, { net });
    if (r.code !== 0) throw new RefusedError(`git ${args[0]}: ${why(r)}`);
    return r.stdout;
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    return withLock(join(this.gitDir, "towercab.lock"), fn);
  }

  /** Abort a rebase a killed run left behind. */
  private async recover(): Promise<void> {
    if (["rebase-merge", "rebase-apply"].some((d) => existsSync(join(this.gitDir, d)))) {
      await this.git(["rebase", "--abort"]);
    }
  }

  private async onMain(): Promise<void> {
    const r = await this.git(["symbolic-ref", "--short", "-q", "HEAD"]);
    const branch = r.code === 0 ? r.stdout.trim() : "detached HEAD";
    if (branch !== "main") throw new RefusedError(`intents: ${this.path} is on ${branch}, not main`);
  }

  /** Throw away uncommitted changes (a write a crash or an error stopped half-way). */
  private async discard(to = "HEAD"): Promise<void> {
    await this.git(["reset", "--quiet", "--hard", to]);
    await this.git(["clean", "-fdq"]);
  }

  private async localCommits(): Promise<string[]> {
    if (!this.origin) return [];
    const out = await this.ok(["log", "--reverse", "--format=%s", "origin/main..HEAD"]);
    return out.split("\n").filter(Boolean);
  }

  private async fetch(): Promise<void> {
    const r = await this.git(["fetch", "--quiet", "origin", "main"], { net: true });
    if (r.code !== 0) throw new SyncError(`pull failed: ${why(r)}`);
  }

  /**
   * Fetch and fast-forward; local commits a killed run left are rebased onto `origin/main` (a
   * conflict only in the views takes `main`'s side; any other drops them, logged) and pushed with
   * the views regenerated.
   */
  private async sync(): Promise<void> {
    await this.recover();
    await this.onMain();
    await this.discard();
    if (!this.origin) return;
    await this.fetch();
    const local = await this.localCommits();
    if (!local.length) {
      const r = await this.git(["merge", "--quiet", "--ff-only", "origin/main"]);
      if (r.code !== 0) throw new SyncError(`pull failed: ${why(r)}`);
      return;
    }
    if (!(await this.rebase(local.length))) {
      await this.git(["rebase", "--abort"]);
      await this.discard("origin/main");
      (this.o.log ?? emit)(`intents: local commits conflict with origin/main, dropped: ${local.join("; ")}`);
      return;
    }
    const s = scan(this.path);
    if (!s.listing.unreadable.some((u) => u.path === LEGACY)) {
      this.writeViews(s);
      await this.commit("towercab: views");
    }
    const r = await this.git(["push", "--quiet", "origin", "HEAD:main"], { net: true });
    if (r.code !== 0) throw new SyncError(`push failed: ${why(r)}`);
  }

  /** Rebase onto `origin/main`, resolving view-only conflicts; false when it can't. */
  private async rebase(n: number): Promise<boolean> {
    let step = await this.git(["rebase", "--quiet", "origin/main"]);
    for (let k = 0; k <= n; k++) {
      if (step.code === 0) return true;
      if (!["rebase-merge", "rebase-apply"].some((d) => existsSync(join(this.gitDir, d)))) return false;
      const conflicted = (await this.git(["diff", "--name-only", "--diff-filter=U"])).stdout
        .split("\n")
        .filter(Boolean);
      if (!conflicted.length || !conflicted.every((f) => VIEWS.includes(f))) return false;
      // `--ours` during a rebase is the branch being rebased onto: main's side.
      if ((await this.git(["checkout", "--ours", "--", ...conflicted])).code !== 0) return false;
      if ((await this.git(["add", "--", ...conflicted])).code !== 0) return false;
      const onlyViews = (await this.git(["diff", "--cached", "--quiet"])).code === 0;
      step = await this.git(["rebase", onlyViews ? "--skip" : "--continue"]);
    }
    return false;
  }

  /** `git add -A` and commit; false when there was nothing to commit. */
  private async commit(msg: string): Promise<boolean> {
    await this.ok(["add", "-A"]);
    if ((await this.ok(["status", "--porcelain"])).trim() === "") return false;
    const r = await this.git(["commit", "--quiet", "-m", msg]);
    if (r.code !== 0) throw new RefusedError(`commit failed: ${why(r)}`);
    return true;
  }

  private writeFile(rel: string, text: string): void {
    if (symlinkIn(this.path, rel)) throw new RefusedError(`${rel}: symlink`);
    const p = join(this.path, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }

  private writeViews(s: Scan): void {
    this.writeFile("TODO.md", todoView(s.listing, this.cutoff));
    this.writeFile("DONE.md", doneView(s.listing, s.legacy));
  }

  /**
   * The write protocol (INT-10) under the lock: `change` edits files for one attempt and returns the
   * commit message (null: nothing to write); it runs again on a fresh `main` after a rejected push.
   */
  private write<T>(change: (s: Scan) => Promise<{ msg: string | null; out: T }>): Promise<T> {
    return this.locked(async () => {
      await this.sync();
      let failed = 0;
      for (;;) {
        const s = scan(this.path);
        const legacy = s.listing.unreadable.find((u) => u.path === LEGACY);
        if (legacy) throw new RefusedError(`${legacy.path}: ${legacy.reason}`);
        let res: { msg: string | null; out: T };
        let committed: boolean;
        try {
          res = await change(s);
          if (res.msg === null) return res.out;
          this.writeViews(scan(this.path));
          committed = await this.commit(res.msg);
        } catch (e) {
          await this.discard();
          if (e instanceof SyncError || e instanceof RefusedError) throw e;
          throw new RefusedError((e as Error).message);
        }
        if (!committed || !this.origin) return res.out;
        const r = await this.git(["push", "--quiet", "origin", "HEAD:main"], { net: true });
        if (r.code === 0) return res.out;
        failed++;
        if (failed > PUSH_RETRIES) {
          await this.discard("origin/main");
          throw new SyncError(`push failed ${failed} times: ${why(r)}`);
        }
        try {
          await this.fetch();
        } finally {
          await this.discard("origin/main");
        }
      }
    });
  }

  async list(): Promise<Listing> {
    return this.locked(async () => {
      await this.sync();
      const { listing } = scan(this.path);
      listing.head = (await this.ok(["rev-parse", this.origin ? "origin/main" : "HEAD"])).trim();
      return listing;
    });
  }

  async get(idOrSuffix: string): Promise<Intent> {
    return findOpen(await this.list(), idOrSuffix);
  }

  async add(n: NewIntent, now: Date): Promise<Intent> {
    const title = n.title.trim();
    if (!title || /[\r\n]/.test(n.title)) throw new RefusedError("the title must be one non-empty line");
    let fm = `repo: ${formatValue("repo", n.repo)}\n`;
    for (const key of ["u", "i", "a"] as const) {
      const v = n[key];
      if (v === undefined) continue;
      if (!Number.isInteger(v) || v < 1 || v > 5) throw new RefusedError(`${key} must be an integer 1-5`);
      fm += `${key}: ${v}\n`;
    }
    fm += `source: ${formatValue("source", n.source ?? "me")}\n`;
    for (const [key, value] of Object.entries(n.fields ?? {})) {
      if (!/^[a-z_]+$/.test(key) || /[\r\n]/.test(value)) throw new RefusedError(`bad field ${key}`);
      fm += `${key}: ${formatValue(key, value)}\n`;
    }
    fm += `started: ${localTime(now)}\n`;
    const text = `---\n${fm}---\n\n# Intent: ${title}\n${n.body?.trim() ? `\n${n.body.trim()}\n` : ""}`;
    try {
      IntentFile.parse(text);
    } catch (e) {
      throw new RefusedError((e as Error).message);
    }
    return this.write(async (s) => {
      const id = newId(now, s.taken);
      const slug = slugOf(title);
      const dir = `intents/${id}-${slug}`;
      this.writeFile(`${dir}/intent.md`, text);
      const f = IntentFile.parse(text);
      [f.id, f.slug, f.dir] = [id, slug, dir];
      return { msg: `towercab: add ${id}${n.mark ? `\n\n${n.mark}` : ""}`, out: f.intent };
    });
  }

  async update(
    idOrSuffix: string,
    what: string,
    fn: (e: IntentEdit) => void,
    mark?: string,
  ): Promise<Intent> {
    // Resolved once: a replay after a rejected push changes the same intent or none.
    let pinned: string | null = null;
    return this.write(async (s) => {
      const found = findOpen(s.listing, pinned ?? idOrSuffix);
      if (pinned !== null && found.id !== pinned) throw new RefusedError(`no open intent matches ${pinned}`);
      pinned = found.id;
      const f = s.files.get(found.id)!.clone();
      const before = f.render();
      fn(f);
      const stage = f.intent.stage;
      const finished = stage === "done" || stage === "dropped";
      if (finished && !f.has("finished"))
        f.setField("finished", localTime((this.o.now ?? (() => new Date()))()));
      const move = finished && f.dir.startsWith("intents/");
      if (f.render() === before && !move) return { msg: null, out: f.intent };
      this.writeFile(`${f.dir}/intent.md`, f.render());
      if (move) {
        const to = `done/${f.id}-${f.slug}`;
        if (symlinkIn(this.path, to) || symlinkIn(this.path, "done"))
          throw new RefusedError(`${to}: symlink`);
        if (existsSync(join(this.path, to))) throw new RefusedError(`${to}: already exists`);
        mkdirSync(join(this.path, "done"), { recursive: true });
        await this.ok(["mv", "--", f.dir, to]);
        f.dir = to;
      }
      return { msg: `towercab: ${what} ${f.id}${mark ? `\n\n${mark}` : ""}`, out: f.intent };
    });
  }

  async editFeatures(
    repo: string,
    what: string,
    fn: (text: string | null) => string | null,
  ): Promise<boolean> {
    if (!isRepoName(repo)) throw new RefusedError(`${repo}: not a repo name`);
    const rel = featuresPath(repo);
    return this.write(async () => {
      if (symlinkIn(this.path, rel)) throw new RefusedError(`${rel}: symlink`);
      let text: string | null = null;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(join(this.path, rel)));
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw new RefusedError(`${rel}: ${code ?? "not UTF-8"}`);
      }
      const next = fn(text);
      if (next === null || next === text) return { msg: null, out: false };
      this.writeFile(rel, next);
      return { msg: `towercab: features ${repo} ${what}`, out: true };
    });
  }

  async hasMark(mark: string): Promise<boolean> {
    return this.locked(async () => {
      await this.sync();
      const log = await this.ok(["log", "-n", "200", "--format=%B%x00", "HEAD"]);
      return log.split(/[\n\0]/).some((l) => l.trim() === mark);
    });
  }

  async readFile(path: string): Promise<string | null> {
    const parts = path.split("/");
    if (!path || path.startsWith("/") || parts.some((p) => p === "" || p === "." || p === "..")) {
      throw new RefusedError(`${path}: not a relative path inside intents`);
    }
    return this.locked(async () => {
      await this.sync();
      if (symlinkIn(this.path, path)) throw new RefusedError(`${path}: symlink`);
      try {
        return readFileSync(join(this.path, path), "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw new RefusedError(`${path}: ${(e as Error).message}`);
      }
    });
  }

  github(): string | null {
    return githubOf(this.o.remote);
  }

  url(i: Intent): string | null {
    const gh = this.github();
    return gh ? `https://github.com/${gh}/blob/main/${i.dir}/intent.md` : null;
  }
}

/** The intent store over `[intents].path`, cloned from `[intents].remote` when missing (INT-12). */
export function openStore(o: StoreOptions): Promise<GitStore> {
  return GitStore.open(o);
}
