// A whole world for pipeline tests: a target repo and an intents repo as local bare repos behind
// `https://github.com/owner/<name>.git` (git `insteadOf`), a fake `gh` that keeps PRs in memory and
// merges them for real, a fake `claude` driven by scripts, a `bwrap` that runs the line with `sh`.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseConfig } from "../../src/config.ts";
import { Db } from "../../src/db.ts";
import type { GitHub } from "../../src/handlers.ts";
import { Home } from "../../src/home.ts";
import { openStore } from "../../src/intents/store.ts";
import type { IntentStore } from "../../src/intents/types.ts";
import { Loop } from "../../src/loop.ts";
import { handlers } from "../../src/pipeline/index.ts";
import type { ChildExit, ChildSpec, RunOpts, RunResult } from "../../src/tools.ts";
import { FakeTools, failResult, okResult } from "./tools.ts";
import { bareRepo, git, TestClock, tempDir } from "./world.ts";

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
}

export type ClaudeScript = (
  spec: ChildSpec,
  prompt: string,
) => { structured: unknown; edits?: Record<string, string>; cost?: number };

export class Pipe {
  readonly tools = new FakeTools();
  readonly clock = new TestClock();
  readonly home: Home;
  readonly db: Db;
  readonly bares: Record<string, string> = {};
  readonly prs: FakePr[] = [];
  readonly claudeCalls: { kind: string; prompt: string; argv: string[] }[] = [];
  store!: IntentStore;
  loop!: Loop;
  private nextPr = 1;
  private claude: ClaudeScript[] = [];
  readonly gitconfig: string;

  constructor(target: Record<string, string>, intents: Record<string, string>) {
    this.home = new Home(tempDir("tc-home-"));
    this.db = Db.memory();
    this.bares.web = bareRepo(target);
    this.bares.intents = bareRepo(intents);
    this.gitconfig = join(tempDir("tc-gitconfig-"), "gitconfig");
    writeFileSync(
      this.gitconfig,
      Object.entries(this.bares)
        .map(([n, b]) => `[url "${b}"]\n\tinsteadOf = https://github.com/owner/${n}.git\n`)
        .join("") + "[user]\n\tname = test\n\temail = test@localhost\n[init]\n\tdefaultBranch = main\n",
    );
    process.env.GIT_CONFIG_GLOBAL = this.gitconfig;
    this.fakeGh();
    this.fakeBwrap();
    this.tools.child("systemd-inhibit", () => new Promise<ChildExit>(() => {}));
    for (let i = 0; i < 50; i++) this.tools.child("claude", (spec) => this.runClaude(spec));
  }

  config(extra: Record<string, unknown> = {}) {
    return parseConfig(
      {
        intents: { remote: "https://github.com/owner/intents.git", cutoff: 1 },
        github: { app_id: 1, me: "owner" },
        agent: { ci_grace: 0, ci_poll: 5, toolchain: [] },
        repos: { web: { github: "owner/web" } },
        ...extra,
      },
      join(this.home.root, "config.toml"),
    );
  }

  github(): GitHub {
    const run = (args: string[], opts?: RunOpts) => this.tools.run("gh", args, opts);
    return {
      me: "owner",
      gh: (_repo, args, opts) => run(args, opts),
      owner: (args, opts) => run(["--as-owner", ...args], opts),
      gitAuth: async () => ({ args: [], env: {} }),
      bot: async () => ({ login: "towercab[bot]", id: 9, email: "9+towercab[bot]@users.noreply.github.com" }),
    };
  }

  async start(extra: Record<string, unknown> = {}): Promise<Loop> {
    const config = this.config(extra);
    this.store = await openStore({
      remote: config.intents.remote,
      path: this.home.intents,
      tools: this.tools,
      cutoff: 1,
    });
    this.loop = new Loop(
      {
        config,
        home: this.home,
        db: this.db,
        tools: this.tools,
        clock: this.clock,
        store: this.store,
        github: this.github(),
        handlers: handlers(),
        log: () => {},
        sender: null,
      },
      { watch: true },
    );
    await this.loop.open();
    return this.loop;
  }

  /** Queue the next Claude runs' answers, in order. */
  script(...s: ClaudeScript[]): void {
    this.claude.push(...s);
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

  pr(head: string): FakePr | undefined {
    return this.prs.find((p) => p.head === head);
  }

  /** A file on a branch of a bare repo. */
  show(repo: string, ref: string, path: string): string {
    return git(this.bares[repo]!, "show", `${ref}:${path}`);
  }

  private runClaude(spec: ChildSpec): ChildExit {
    const prompt = readFileSync(spec.stdin!, "utf8");
    const kind = spec.kind;
    this.claudeCalls.push({ kind, prompt, argv: spec.argv });
    const s = this.claude.shift();
    if (!s) {
      writeFileSync(spec.stdout, "");
      writeFileSync(spec.stderr, "no claude script left\n");
      return { code: 1, signal: null };
    }
    const r = s(spec, prompt);
    for (const [path, text] of Object.entries(r.edits ?? {})) {
      mkdirSync(dirname(join(spec.cwd, path)), { recursive: true });
      writeFileSync(join(spec.cwd, path), text);
    }
    writeFileSync(
      spec.stdout,
      `${JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        session_id: "s-1",
        total_cost_usd: r.cost ?? 0.5,
        duration_ms: 60_000,
        structured_output: r.structured,
        permission_denials: [],
      })}\n`,
    );
    writeFileSync(spec.stderr, "");
    return { code: 0, signal: null };
  }

  private fakeBwrap(): void {
    for (let i = 0; i < 100; i++) {
      this.tools.child("bwrap", (spec) => {
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
      });
    }
  }

  private repoOf(args: string[]): string {
    const i = args.indexOf("-R");
    return i >= 0 ? args[i + 1]! : "owner/web";
  }

  private bareOf(github: string): string {
    return this.bares[github.split("/")[1]!]!;
  }

  private headSha(github: string, branch: string): string {
    return git(this.bareOf(github), "rev-parse", `refs/heads/${branch}`).trim();
  }

  /** Squash-merge a PR in its bare repo, as GitHub would. */
  mergePr(p: FakePr): void {
    const work = join(tempDir("tc-merge-"), "w");
    git(dirname(work), "clone", "-q", this.bareOf(p.repo), work);
    git(work, "merge", "--squash", `origin/${p.head}`);
    git(work, "commit", "-q", "--allow-empty", "-m", `${p.title} (#${p.number})`);
    git(work, "push", "-q", "origin", "HEAD:main");
    p.state = "MERGED";
    p.mergeCommit = git(work, "rev-parse", "HEAD").trim();
  }

  private fakeGh(): void {
    const json = (v: unknown) => okResult(JSON.stringify(v));
    this.tools.on("gh", (raw, opts) => {
      const args = raw[0] === "--as-owner" ? raw.slice(1) : raw;
      const repo = this.repoOf(args);
      const flag = (f: string) => {
        const i = args.indexOf(f);
        return i >= 0 ? args[i + 1]! : "";
      };
      const [a, b] = args;
      if (a === "pr" && b === "list") {
        const p = this.prs.find((x) => x.repo === repo && x.head === flag("--head") && x.state === "OPEN");
        return json(p ? [{ number: p.number }] : []);
      }
      if (a === "pr" && b === "create") {
        const p: FakePr = {
          number: this.nextPr++,
          repo,
          head: flag("--head"),
          base: flag("--base"),
          title: flag("--title"),
          body: opts.input ?? "",
          state: "OPEN",
          mergeCommit: null,
          comments: [],
          reviews: [],
        };
        this.prs.push(p);
        return okResult(`https://github.com/${repo}/pull/${p.number}\n`);
      }
      const n = Number(args[2]);
      const p = this.prs.find((x) => x.repo === repo && x.number === n);
      if (a === "pr" && b === "view" && p) {
        const fields = flag("--json").split(",");
        const all: Record<string, unknown> = {
          state: p.state,
          mergedAt: p.state === "MERGED" ? "2026-10-26T12:00:00Z" : null,
          mergeCommit: p.mergeCommit ? { oid: p.mergeCommit } : null,
          headRefOid: this.headSha(p.repo, p.head),
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          statusCheckRollup: [],
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
        this.mergePr(p);
        return okResult();
      }
      if (a === "pr" && b === "comment" && p) {
        p.comments.push({
          id: `c${p.comments.length + 1}`,
          author: "towercab[bot]",
          body: opts.input ?? "",
          at: "2026-10-26T12:00:00Z",
        });
        return okResult();
      }
      if (a === "pr" && (b === "ready" || b === "close")) {
        if (p && b === "close") p.state = "CLOSED";
        return okResult();
      }
      if (a === "api") {
        const path = args.find((x) => x.startsWith("repos/")) ?? "";
        const m = /^repos\/([^/]+\/[^/]+)\/(pulls|issues)\/(\d+)(\/comments)?/.exec(path);
        if (m && m[4]) {
          const pr = this.prs.find((x) => x.repo === m[1] && x.number === Number(m[3]));
          if (m[2] === "pulls") return okResult("[]");
          return json(
            (pr?.comments ?? []).map((c) => ({
              id: Number(c.id.slice(1)),
              body: c.body,
              user: { login: c.author },
            })),
          );
        }
        if (m && args.includes("PATCH")) {
          const pr = this.prs.find((x) => x.repo === m[1] && x.number === Number(m[3]));
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

export function result(structured: unknown, edits?: Record<string, string>): ClaudeScript {
  return () => ({ structured, edits });
}

export function runSh(cwd: string, line: string): RunResult {
  try {
    return okResult(execFileSync("sh", ["-c", line], { cwd, encoding: "utf8" }));
  } catch (e) {
    return failResult(String((e as Error).message));
  }
}
