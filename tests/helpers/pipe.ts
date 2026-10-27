// A whole world for pipeline tests: a target repo and an intents repo as local bare repos behind
// `https://github.com/owner/<name>.git` (git `insteadOf`), a fake `gh` that keeps PRs in memory and
// merges them for real, a fake `claude` driven by scripts, a `bwrap` that runs the line with `sh`.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseConfig } from "../../src/config.ts";
import { Db } from "../../src/db.ts";
import type { GitHub, Handlers } from "../../src/handlers.ts";
import { Home } from "../../src/home.ts";
import { findOpen, openStore } from "../../src/intents/store.ts";
import type { Intent, IntentEdit, IntentStore, Listing, NewIntent } from "../../src/intents/types.ts";
import { Loop, type LoopDeps } from "../../src/loop.ts";
import type { Stage } from "../../src/machine.ts";
import { getMission, type Mission } from "../../src/mission.ts";
import { handlers } from "../../src/pipeline/index.ts";
import type { ChildExit, ChildHandle, ChildSpec, RunOpts, RunResult } from "../../src/tools.ts";
import { FakeTools, failResult, okResult } from "./tools.ts";
import { git, TestClock, tempDir } from "./world.ts";

export interface FakePr {
  number: number;
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  mergeCommit: string | null;
  comments: { id: string; author: string; body: string; at: string }[];
  reviews: { author: string; state: string; body: string; at: string; commit: string }[];
  /** `statusCheckRollup` for the PR's current head. */
  checks: (pr: FakePr, head: string) => unknown[];
  mergeable: string;
  /** `mergeStateStatus` answers, one per read that asks for it; then `CLEAN`. */
  mergeStates: string[];
}

export interface FakeIssue {
  repo: string;
  number: number;
  author: string;
  labels: string[];
  state: "OPEN" | "CLOSED";
  title: string;
  body: string;
  comments: string[];
}

/** What a fake Claude run does. */
export interface ClaudeReply {
  structured?: unknown;
  /** Files written into the run's cwd (path → text; null deletes). */
  edits?: Record<string, string | null>;
  /** `total_cost_usd` (the session's running total on a resume). Default 0.5. */
  cost?: number;
  durationMs?: number;
  /** Written to stderr. */
  stderr?: string;
  code?: number;
  isError?: boolean;
  result?: string;
  subtype?: string;
  /** Print no result line at all. */
  noResult?: boolean;
  /** Never end on its own (killed by a timeout or a move). */
  hang?: boolean;
}

export type ClaudeScript = (spec: ChildSpec, prompt: string) => ClaudeReply;

export interface ClaudeCall {
  kind: string;
  prompt: string;
  argv: string[];
  /** `--session-id <id>` → new, `--resume <id>` → resume. */
  session: { mode: "new" | "resume" | "none"; id: string };
  model: string;
  cwd: string;
  /** The run's `--settings` file, parsed. */
  settings: Record<string, unknown>;
}

const PID_OFFSET = 9_000_000;

/** FakeTools whose children route by command and whose pids no real process has. */
export class PipeTools extends FakeTools {
  readonly routes = new Map<string, (spec: ChildSpec) => ChildExit | Promise<ChildExit>>();
  /** After a simulated crash every call fails (the process is gone). */
  dead: (() => Error) | null = null;

  override async run(cmd: string, args: string[], opts: RunOpts = {}): Promise<RunResult> {
    if (this.dead) throw this.dead();
    return super.run(cmd, args, opts);
  }

  /** Signals sent to children, by kind. */
  readonly kills: { kind: string; signal: string }[] = [];
  /** Kinds of children that ignore SIGTERM (only SIGKILL ends them). */
  readonly stubborn = new Set<string>();

  override spawn(spec: ChildSpec): ChildHandle {
    if (this.dead) throw this.dead();
    const cmd = spec.argv[0]!.split("/").pop()!;
    const route = this.routes.get(cmd);
    if (route) this.child(cmd, route);
    const h = super.spawn(spec);
    // A fake pid above pid_max: killing its group can never reach a real process.
    return {
      pid: h.pid + PID_OFFSET,
      done: h.done,
      kill: (signal) => {
        this.kills.push({ kind: spec.kind, signal });
        if (signal === "SIGTERM" && this.stubborn.has(spec.kind)) return;
        h.kill(signal);
      },
    };
  }
}

/**
 * The real store, with its reads remembered until the intents repo's `main` moves or the store
 * writes: every read of the real one syncs (about six git calls), which made flows slow.
 */
export class CachedStore implements IntentStore {
  private readonly s: IntentStore;
  private readonly bare: string;
  private key = "";
  private writes = 0;
  private listed: Listing | null = null;
  private files = new Map<string, string | null>();
  private marks = new Map<string, boolean>();

  constructor(s: IntentStore, bare: string) {
    this.s = s;
    this.bare = bare;
  }

  /** `main` of the bare repo (a loose ref, else packed), and the writes made. */
  private fresh(): void {
    const loose = join(this.bare, "refs/heads/main");
    const main = existsSync(loose)
      ? readFileSync(loose, "utf8")
      : (/^(\S+) refs\/heads\/main$/m.exec(readFileSync(join(this.bare, "packed-refs"), "utf8"))?.[1] ?? "");
    const key = `${main.trim()} ${this.writes}`;
    if (key === this.key) return;
    this.key = key;
    this.listed = null;
    this.files.clear();
    this.marks.clear();
  }

  async list(): Promise<Listing> {
    this.fresh();
    this.listed ??= await this.s.list();
    return this.listed;
  }
  async get(idOrSuffix: string): Promise<Intent> {
    return findOpen(await this.list(), idOrSuffix);
  }
  async add(n: NewIntent, now: Date): Promise<Intent> {
    try {
      return await this.s.add(n, now);
    } finally {
      this.writes++;
    }
  }
  async update(id: string, what: string, fn: (e: IntentEdit) => void, mark?: string): Promise<Intent> {
    try {
      return await this.s.update(id, what, fn, mark);
    } finally {
      this.writes++;
    }
  }
  async hasMark(mark: string): Promise<boolean> {
    this.fresh();
    if (!this.marks.has(mark)) this.marks.set(mark, await this.s.hasMark(mark));
    return this.marks.get(mark)!;
  }
  async readFile(path: string): Promise<string | null> {
    this.fresh();
    if (!this.files.has(path)) this.files.set(path, await this.s.readFile(path));
    return this.files.get(path)!;
  }
  github(): string | null {
    return this.s.github();
  }
  url(i: Intent): string | null {
    return this.s.url(i);
  }
}

export interface StartOpts {
  handlers?: Handlers;
  readPr?: LoopDeps["readPr"];
  /** Wrap the store the loop uses (crash tests). */
  wrapStore?: (s: IntentStore) => IntentStore;
  watch?: boolean;
  intent?: string;
  sender?: LoopDeps["sender"];
}

export class Pipe {
  readonly tools = new PipeTools();
  readonly clock = new TestClock();
  readonly home: Home;
  readonly db: Db;
  readonly bares: Record<string, string> = {};
  readonly prs: FakePr[] = [];
  readonly claudeCalls: ClaudeCall[] = [];
  /** Sandboxed runs (`bwrap`): kind, argv and where. */
  readonly sandboxRuns: { kind: string; argv: string[]; cwd: string }[] = [];
  /** `gh run rerun` run IDs. */
  readonly reruns: number[] = [];
  /** Heads GitHub's "update branch" made. */
  readonly updates: string[] = [];
  /** Every log line the loop wrote. */
  readonly logs: string[] = [];
  /** Per-kind answers used when the queue is empty. */
  readonly respond: Partial<Record<string, ClaudeScript>> = {};
  /** Overrides a sandbox run; return null to run it with `sh`. */
  sandbox: ((spec: ChildSpec) => ChildExit | null) | null = null;
  store!: IntentStore;
  rawStore!: IntentStore;
  loop!: Loop;
  private nextPr = 1;
  private nextComment = 1;
  private claude: ClaudeScript[] = [];
  private queues = new Map<string, ClaudeScript[]>();
  private startOpts: StartOpts = {};
  private extra: Record<string, unknown> = {};
  readonly gitconfig: string;
  /** Kept across tests (a flow shared by several tests): its own folder, removed by `cleanup()`. */
  private root: string | null;
  private savedGitConfig = process.env.GIT_CONFIG_GLOBAL;

  constructor(target: Record<string, string>, intents: Record<string, string>, o: { keep?: boolean } = {}) {
    this.root = o.keep ? mkdtempSync(join(tmpdir(), "tc-pipe-")) : null;
    this.home = new Home(this.dir("tc-home-"));
    this.db = Db.memory();
    this.bares.web = this.bareRepo(target);
    this.bares.intents = this.bareRepo(intents);
    this.gitconfig = join(this.dir("tc-gitconfig-"), "gitconfig");
    writeFileSync(
      this.gitconfig,
      `${Object.entries(this.bares)
        .map(([n, b]) => `[url "${b}"]\n\tinsteadOf = https://github.com/owner/${n}.git\n`)
        .join("")}[user]\n\tname = test\n\temail = test@localhost\n[init]\n\tdefaultBranch = main\n`,
    );
    process.env.GIT_CONFIG_GLOBAL = this.gitconfig;
    this.fakeGh();
    this.tools.routes.set("bwrap", (spec) => this.runSandbox(spec));
    this.tools.routes.set("claude", (spec) => this.runClaude(spec));
    this.tools.routes.set("systemd-inhibit", () => new Promise<ChildExit>(() => {}));
  }

  /** A fresh folder: under the kept root, else removed after the test. */
  dir(prefix: string): string {
    return this.root ? mkdtempSync(join(this.root, prefix)) : tempDir(prefix);
  }

  /** Remove a kept world and restore the git config. */
  cleanup(): void {
    if (this.savedGitConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = this.savedGitConfig;
    if (this.root) rmSync(this.root, { recursive: true, force: true });
  }

  /** A bare repo seeded with `files` on main. */
  bareRepo(files: Record<string, string>): string {
    const root = this.dir("tc-remote-");
    const bare = join(root, "origin.git");
    const work = join(root, "seed");
    git(root, "init", "-q", "--bare", "-b", "main", bare);
    mkdirSync(work);
    git(work, "init", "-q", "-b", "main");
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(work, path)), { recursive: true });
      writeFileSync(join(work, path), text);
    }
    git(work, "add", "-A");
    git(work, "commit", "-q", "--allow-empty", "-m", "seed");
    git(work, "push", "-q", bare, "main");
    return bare;
  }

  config(extra: Record<string, unknown> = {}) {
    const { agent, ...rest } = extra as { agent?: Record<string, unknown> };
    return parseConfig(
      {
        intents: { remote: "https://github.com/owner/intents.git", cutoff: 1 },
        github: { app_id: 1, me: "owner" },
        repos: { web: { github: "owner/web" } },
        ...rest,
        agent: { ci_grace: 0, ci_poll: 5, toolchain: [], ...(agent ?? {}) },
      },
      join(this.home.root, "config.toml"),
    );
  }

  github(): GitHub {
    return {
      me: "owner",
      gh: (_repo, args, opts) => this.tools.run("gh", args, opts),
      owner: (args, opts) => this.tools.run("gh", ["--as-owner", ...args], opts),
      gitAuth: async () => ({ args: [], env: {} }),
      bot: async () => ({ login: "towercab[bot]", id: 9, email: "9+towercab[bot]@users.noreply.github.com" }),
    };
  }

  async start(extra: Record<string, unknown> = {}, opts: StartOpts = {}): Promise<Loop> {
    this.extra = extra;
    this.startOpts = opts;
    const config = this.config(extra);
    this.rawStore = await openStore({
      remote: config.intents.remote,
      path: this.home.intents,
      tools: this.tools,
      cutoff: 1,
    });
    const cached = new CachedStore(this.rawStore, this.bares.intents!);
    this.store = opts.wrapStore ? opts.wrapStore(cached) : cached;
    this.loop = this.newLoop();
    await this.loop.open();
    return this.loop;
  }

  private newLoop(): Loop {
    const o = this.startOpts;
    return new Loop(
      {
        config: this.config(this.extra),
        home: this.home,
        db: this.db,
        tools: this.tools,
        clock: this.clock,
        store: this.store,
        github: this.github(),
        handlers: o.handlers ?? handlers(),
        log: (l) => this.logs.push(l),
        sender: o.sender ?? null,
        ...(o.readPr ? { readPr: o.readPr } : {}),
      },
      { watch: o.watch ?? true, ...(o.intent ? { intent: o.intent } : {}) },
    );
  }

  /** A restart: a new loop on the same database, home and repos (the old one is dropped as is). */
  async reopen(): Promise<Loop> {
    this.loop = this.newLoop();
    await this.loop.open();
    return this.loop;
  }

  /** Queue the next Claude runs' answers, in order, whatever their kind. */
  script(...s: ClaudeScript[]): void {
    this.claude.push(...s);
  }

  /** Queue the next answers of one kind of run (before `script`'s and `respond`). */
  queue(kind: string, ...s: ClaudeScript[]): void {
    this.queues.set(kind, [...(this.queues.get(kind) ?? []), ...s]);
  }

  /** Passes 61 s apart (every poll due) until `done` or `max` passes. */
  async until(done: () => boolean, max = 60): Promise<number> {
    for (let i = 0; i < max; i++) {
      await this.loop.pass();
      if (done()) return i + 1;
      await new Promise((r) => setTimeout(r, 2));
      this.clock.advance(61);
    }
    return -1;
  }

  /** Passes until the newest mission is at `stage` (its entry effects done); throws after `max`. */
  async untilStage(stage: Stage, max = 60): Promise<Mission> {
    const n = await this.until(() => {
      const m = this.mission();
      return m?.stage === stage && m.step !== "enter";
    }, max);
    if (n < 0) {
      const m = this.mission();
      throw new Error(
        `never reached ${stage}: at ${m?.stage}/${m?.step} waiting ${m?.waiting} why ${m?.why}\n${this.moves()}`,
      );
    }
    return this.mission()!;
  }

  /** The newest mission (or mission `id`). */
  mission(id?: number): Mission | undefined {
    if (id !== undefined) return getMission(this.db, id);
    return this.db.get<Mission>("SELECT * FROM missions ORDER BY id DESC LIMIT 1");
  }

  /** The moves so far, one per line (for failure messages). */
  moves(): string {
    return this.db
      .all<{ mission: number; from_stage: string; event: string; to_stage: string; why: string | null }>(
        "SELECT mission, from_stage, event, to_stage, why FROM transitions ORDER BY id",
      )
      .map((t) => `${t.mission}: ${t.from_stage} → ${t.to_stage} (${t.event}${t.why ? `: ${t.why}` : ""})`)
      .join("\n");
  }

  /** The stages one mission entered, in order (from its moves). */
  stages(mission: number): string[] {
    return this.db
      .all<{ to_stage: string }>("SELECT to_stage FROM transitions WHERE mission = ? ORDER BY id", mission)
      .map((t) => t.to_stage);
  }

  pr(head: string): FakePr | undefined {
    return this.prs.find((p) => p.head === head);
  }

  /** A PR by repo name (`web`, `intents`) and number. */
  prNo(repo: string, n: number): FakePr {
    const p = this.prs.find((x) => x.repo === `owner/${repo}` && x.number === n);
    if (!p) throw new Error(`no PR ${repo}#${n}`);
    return p;
  }

  /** A file on a branch of a bare repo. */
  show(repo: string, ref: string, path: string): string {
    return git(this.bares[repo]!, "show", `${ref}:${path}`);
  }

  /** The current time as GitHub prints it. */
  at(): string {
    return new Date(this.clock.now() * 1000).toISOString();
  }

  /** The owner comments on a PR. */
  ownerComment(p: FakePr, body: string): void {
    p.comments.push({ id: `c${this.nextComment++}`, author: "owner", body, at: this.at() });
  }

  /** The owner submits a review on the PR's current head. */
  ownerReview(p: FakePr, state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED", body: string): void {
    p.reviews.push({ author: "owner", state, body, at: this.at(), commit: this.headSha(p.repo, p.head) });
  }

  /**
   * Another open PR of `repo`: a new branch off `main` with `files` committed, and its PR. With
   * `branch: false` only the PR exists (its branch can't be read).
   */
  openOtherPr(repo: string, head: string, files: Record<string, string>, branch = true): FakePr {
    if (branch) {
      const work = join(this.dir("tc-other-"), "w");
      git(dirname(work), "clone", "-q", this.bares[repo]!, work);
      git(work, "checkout", "-q", "-b", head);
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(work, path)), { recursive: true });
        writeFileSync(join(work, path), text);
      }
      git(work, "add", "-A");
      git(work, "commit", "-q", "-m", "docs(specs): other");
      git(work, "push", "-q", "origin", head);
    }
    const pr: FakePr = {
      number: this.nextPr++,
      repo: `owner/${repo}`,
      head,
      base: "main",
      title: "docs(specs): other",
      body: "",
      state: "OPEN",
      mergeCommit: null,
      comments: [],
      reviews: [],
      checks: () => [],
      mergeable: "MERGEABLE",
      mergeStates: [],
    };
    this.prs.push(pr);
    return pr;
  }

  /** Commit files on a branch of a bare repo (the owner pushing). */
  pushTo(repo: string, branch: string, files: Record<string, string | null>, msg = "owner edit"): void {
    const work = join(this.dir("tc-push-"), "w");
    git(dirname(work), "clone", "-q", "-b", branch, this.bares[repo]!, work);
    for (const [path, text] of Object.entries(files)) {
      if (text === null) rmSync(join(work, path), { force: true });
      else {
        mkdirSync(dirname(join(work, path)), { recursive: true });
        writeFileSync(join(work, path), text);
      }
    }
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", msg);
    git(work, "push", "-q", "origin", branch);
  }

  private runSandbox(spec: ChildSpec): ChildExit {
    this.sandboxRuns.push({ kind: spec.kind, argv: spec.argv, cwd: spec.cwd });
    const over = this.sandbox?.(spec);
    if (over) return over;
    const at = spec.argv.indexOf("--");
    const [cmd, ...args] = spec.argv.slice(at + 1);
    const r = spawnSync(cmd!, args, {
      cwd: spec.cwd,
      encoding: "utf8",
      env: { ...process.env, ...spec.env, HOME: process.env.HOME },
    });
    writeFileSync(spec.stdout, r.stdout ?? "");
    writeFileSync(spec.stderr, r.stderr ?? "");
    return { code: r.status, signal: null };
  }

  private runClaude(spec: ChildSpec): ChildExit | Promise<ChildExit> {
    const prompt = readFileSync(spec.stdin!, "utf8");
    const kind = spec.kind;
    const flag = (f: string) => {
      const i = spec.argv.indexOf(f);
      return i >= 0 ? spec.argv[i + 1]! : null;
    };
    const sid = flag("--session-id");
    const rid = flag("--resume");
    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(readFileSync(flag("--settings")!, "utf8")) as Record<string, unknown>;
    } catch {
      // No settings file.
    }
    this.claudeCalls.push({
      kind,
      prompt,
      argv: spec.argv,
      session: sid ? { mode: "new", id: sid } : rid ? { mode: "resume", id: rid } : { mode: "none", id: "" },
      model: flag("--model") ?? "",
      cwd: spec.cwd,
      settings,
    });
    const s = this.queues.get(kind)?.shift() ?? this.claude.shift() ?? this.respond[kind];
    if (!s) {
      writeFileSync(spec.stdout, "");
      writeFileSync(spec.stderr, "no claude script left\n");
      return { code: 1, signal: null };
    }
    const r = s(spec, prompt);
    for (const [path, text] of Object.entries(r.edits ?? {})) {
      if (text === null) {
        rmSync(join(spec.cwd, path), { force: true });
        continue;
      }
      mkdirSync(dirname(join(spec.cwd, path)), { recursive: true });
      writeFileSync(join(spec.cwd, path), text);
    }
    writeFileSync(spec.stderr, r.stderr ?? "");
    if (r.hang) {
      writeFileSync(spec.stdout, "");
      return new Promise<ChildExit>(() => {});
    }
    writeFileSync(
      spec.stdout,
      r.noResult
        ? ""
        : `${JSON.stringify({
            type: "result",
            subtype: r.subtype ?? "success",
            is_error: r.isError ?? false,
            result: r.result ?? "done",
            session_id: sid ?? rid ?? "s-1",
            total_cost_usd: r.cost ?? 0.5,
            duration_ms: r.durationMs ?? 60_000,
            structured_output: r.structured ?? null,
            permission_denials: [],
          })}\n`,
    );
    return { code: r.code ?? 0, signal: null };
  }

  private repoOf(args: string[]): string {
    const i = args.indexOf("-R");
    return i >= 0 ? args[i + 1]! : "owner/web";
  }

  private bareOf(github: string): string {
    return this.bares[github.split("/")[1]!]!;
  }

  headSha(github: string, branch: string): string {
    return git(this.bareOf(github), "rev-parse", `refs/heads/${branch}`).trim();
  }

  /** Squash-merge a PR in its bare repo, as GitHub would (the owner's merge button). */
  mergePr(p: FakePr): void {
    if (p.state !== "OPEN") throw new Error(`PR ${p.number} is ${p.state.toLowerCase()}`);
    const work = join(this.dir("tc-merge-"), "w");
    git(dirname(work), "clone", "-q", this.bareOf(p.repo), work);
    git(work, "merge", "--squash", `origin/${p.head}`);
    git(work, "commit", "-q", "--allow-empty", "-m", `${p.title} (#${p.number})`);
    git(work, "push", "-q", "origin", "HEAD:main");
    p.state = "MERGED";
    p.mergeCommit = git(work, "rev-parse", "HEAD").trim();
  }

  /** GitHub's "update branch": merge the base into the PR's head. */
  private updateBranch(p: FakePr): void {
    const work = join(this.dir("tc-update-"), "w");
    git(dirname(work), "clone", "-q", "-b", p.head, this.bareOf(p.repo), work);
    git(work, "merge", "-q", "--no-edit", "origin/main");
    git(work, "push", "-q", "origin", p.head);
    this.updates.push(git(work, "rev-parse", "HEAD").trim());
  }

  /** A GitHub issue the fake `gh` serves (`issue list|view|comment|edit`, `label create`). */
  readonly issues: FakeIssue[] = [];
  /** Every `gh issue …` / `gh label …` call, as one line. */
  readonly issueCalls: string[] = [];
  /** Return a reason to make that issue call fail. */
  issueFail: ((args: string[]) => string | null) | null = null;

  /** Add an issue to `owner/web` (or `repo`), open, by the owner, with no labels. */
  issue(o: Partial<FakeIssue> = {}): FakeIssue {
    const repo = o.repo ?? "owner/web";
    const it: FakeIssue = {
      repo,
      number: this.issues.filter((x) => x.repo === repo).length + 1,
      author: "owner",
      labels: [],
      state: "OPEN",
      title: "The page greets nobody",
      body: "Visitors see an empty page.",
      comments: [],
      ...o,
    };
    this.issues.push(it);
    return it;
  }

  private issueGh(args: string[], opts: RunOpts): RunResult {
    this.issueCalls.push(args.join(" "));
    const bad = this.issueFail?.(args);
    if (bad) return failResult(bad);
    const json = (v: unknown) => okResult(JSON.stringify(v));
    const repo = this.repoOf(args);
    const flag = (f: string) => args[args.indexOf(f) + 1] ?? "";
    const [a, b] = args;
    if (a === "label") return okResult();
    const labels = (it: FakeIssue) => it.labels.map((name) => ({ name }));
    if (b === "list") {
      return json(
        this.issues
          .filter((i) => i.repo === repo)
          .map((i) => ({
            number: i.number,
            url: `https://github.com/${repo}/issues/${i.number}`,
            state: i.state,
            author: { login: i.author },
            labels: labels(i),
          })),
      );
    }
    const it = this.issues.find((x) => x.repo === repo && x.number === Number(args[2]));
    if (!it) return failResult(`issue ${args[2]} not found`);
    if (b === "view") {
      return json({ title: it.title, body: it.body, author: { login: it.author }, labels: labels(it) });
    }
    if (b === "comment") it.comments.push(opts.input ?? "");
    if (b === "edit" && args.includes("--add-label")) it.labels.push(flag("--add-label"));
    return okResult();
  }

  private fakeGh(): void {
    const json = (v: unknown) => okResult(JSON.stringify(v));
    this.tools.on("gh", (raw, opts) => {
      const asOwner = raw[0] === "--as-owner";
      const args = asOwner ? raw.slice(1) : raw;
      const repo = this.repoOf(args);
      const flag = (f: string) => {
        const i = args.indexOf(f);
        return i >= 0 ? args[i + 1]! : "";
      };
      const [a, b] = args;
      if (a === "issue" || a === "label") return this.issueGh(args, opts);
      if (a === "pr" && b === "list" && !args.includes("--head")) {
        return json(
          this.prs
            .filter((x) => x.repo === repo && x.state === "OPEN")
            .map((x) => ({ number: x.number, headRefName: x.head })),
        );
      }
      if (a === "pr" && b === "list") {
        const p = this.prs.find((x) => x.repo === repo && x.head === flag("--head") && x.state === "OPEN");
        return json(p ? [{ number: p.number }] : []);
      }
      if (a === "pr" && b === "create") {
        const head = flag("--head");
        if (this.prs.some((x) => x.repo === repo && x.head === head && x.state === "OPEN"))
          return failResult(`a pull request for branch "${head}" into branch "main" already exists`);
        const p: FakePr = {
          number: this.nextPr++,
          repo,
          head,
          base: flag("--base"),
          title: flag("--title"),
          body: opts.input ?? "",
          state: "OPEN",
          mergeCommit: null,
          comments: [],
          reviews: [],
          checks: () => [],
          mergeable: "MERGEABLE",
          mergeStates: [],
        };
        this.prs.push(p);
        return okResult(`https://github.com/${repo}/pull/${p.number}\n`);
      }
      if (a === "run" && b === "rerun") {
        this.reruns.push(Number(args[2]));
        return okResult();
      }
      if (a === "run" && b === "view") return okResult(`run ${args[2]}: Error: a test failed\n`);
      const n = Number(args[2]);
      const p = this.prs.find((x) => x.repo === repo && x.number === n);
      if (a === "pr" && b === "view" && p) {
        const fields = flag("--json").split(",");
        const head = this.headSha(p.repo, p.head);
        const all: Record<string, unknown> = {
          state: p.state,
          mergedAt: p.state === "MERGED" ? "2026-10-26T12:00:00Z" : null,
          mergeCommit: p.mergeCommit ? { oid: p.mergeCommit } : null,
          headRefOid: head,
          mergeable: p.mergeable,
          mergeStateStatus: fields.includes("mergeStateStatus")
            ? (p.mergeStates.shift() ?? "CLEAN")
            : "CLEAN",
          statusCheckRollup: fields.includes("statusCheckRollup") ? p.checks(p, head) : [],
          isDraft: false,
          body: p.body,
          reviews: p.reviews.map((r) => ({
            author: { login: r.author },
            state: r.state,
            body: r.body,
            submittedAt: r.at,
            commit: { oid: r.commit },
          })),
          comments: p.comments.map((c) => ({
            id: c.id,
            author: { login: c.author },
            body: c.body,
            createdAt: c.at,
          })),
        };
        return json(Object.fromEntries(fields.map((f) => [f, all[f]])));
      }
      if (a === "pr" && b === "merge" && p) {
        if (p.state !== "OPEN") return failResult(`Pull request #${p.number} was already merged or closed`);
        const match = flag("--match-head-commit");
        if (match && match !== this.headSha(p.repo, p.head))
          return failResult("Head branch was modified. Review and try the merge again.");
        this.mergePr(p);
        return okResult();
      }
      if (a === "pr" && b === "comment" && p) {
        p.comments.push({
          id: `c${this.nextComment++}`,
          author: asOwner ? "owner" : "towercab[bot]",
          body: opts.input ?? "",
          at: this.at(),
        });
        return okResult();
      }
      if (a === "pr" && (b === "ready" || b === "close")) {
        if (p && b === "close") {
          p.state = "CLOSED";
          const why = args[args.indexOf("--comment") + 1];
          if (args.includes("--comment") && why) {
            p.comments.push({
              id: `c${this.nextComment++}`,
              author: "towercab[bot]",
              body: why,
              at: this.at(),
            });
          }
        }
        return okResult();
      }
      if (a === "api") {
        const path = args.find((x) => x.startsWith("repos/")) ?? "";
        const edit = /^repos\/([^/]+\/[^/]+)\/issues\/comments\/(\d+)$/.exec(path);
        if (edit) {
          for (const pr of this.prs.filter((x) => x.repo === edit[1])) {
            const c = pr.comments.find((x) => x.id === `c${edit[2]}`);
            if (c) c.body = (JSON.parse(opts.input ?? "{}") as { body: string }).body;
          }
          return okResult("{}");
        }
        const m = /^repos\/([^/]+\/[^/]+)\/(pulls|issues)\/(\d+)(\/comments|\/update-branch)?/.exec(path);
        const pr = m ? this.prs.find((x) => x.repo === m[1] && x.number === Number(m[3])) : undefined;
        if (m?.[4] === "/update-branch" && pr) {
          this.updateBranch(pr);
          return okResult("{}");
        }
        if (m?.[4] === "/comments") {
          if (m[2] === "pulls") return okResult("[]");
          return json(
            (pr?.comments ?? []).map((c) => ({
              id: Number(c.id.slice(1)),
              body: c.body,
              user: { login: c.author },
              created_at: c.at,
            })),
          );
        }
        if (m && args.includes("PATCH")) {
          if (pr) pr.body = opts.input ?? pr.body;
          return okResult("{}");
        }
        return okResult("{}");
      }
      if (a === "auth") return okResult("Logged in to github.com account owner");
      return failResult(`fake gh: unhandled ${args.join(" ")}`);
    });
  }
}

export function result(structured: unknown, edits?: Record<string, string | null>): ClaudeScript {
  return () => ({ structured, ...(edits ? { edits } : {}) });
}

export function runSh(cwd: string, line: string): RunResult {
  try {
    return okResult(execFileSync("sh", ["-c", line], { cwd, encoding: "utf8" }));
  } catch (e) {
    return failResult(String((e as Error).message));
  }
}
