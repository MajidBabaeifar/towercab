// The observer (OBV-1..12): a read-only Claude run that reads how Towercab ran and proposes improvements
// as intents. `pass()` is called by the loop each pass; a run is a detached child with no tools, no
// credentials and no network, that later passes reap, so a slow answer never delays the loop. Towercab's
// own code checks the answer and does the only three things the observer may do (OBV-11).

import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentTimeoutMin, loadAgent } from "../agents.ts";
import { type ClaudeRun, parseRun, prepareRun, runEndLine } from "../claude.ts";
import { type Config, reloadObserver } from "../config.ts";
import type { Db } from "../db.ts";
import type { ProposedPr } from "../github/proposed.ts";
import type { Clock, GitHub } from "../handlers.ts";
import type { Home } from "../home.ts";
import type { IntentStore, Listing } from "../intents/types.ts";
import { fence, render } from "../pipeline/prompts.ts";
import { type ObserverFinding, parseResult, SCHEMAS } from "../pipeline/schemas.ts";
import { checkoutRoot } from "../service.ts";
import type { ChildHandle, ChildSpec, Tools } from "../tools.ts";
import { buildBundle } from "./bundle.ts";
import { markStarted, nextTrigger, scanEvents } from "./due.ts";
import { judge } from "./findings.ts";
import { commentEvidence, openProposal } from "./propose.ts";
import { queueReport } from "./report.ts";
import { readSteering } from "./steering.ts";
import {
  costToday,
  type Finished,
  failStale,
  finishRun,
  proposalsSince,
  prune,
  recordProposal,
  startRun,
  WEEK_S,
} from "./store.ts";

/** The `observer` fault kind (LOOP-10): it never pauses picks (see `Health`). */
export const FAULT = "observer";

export interface ObserverDeps {
  config: Config;
  home: Home;
  db: Db;
  tools: Tools;
  clock: Clock;
  github: GitHub;
  store: IntentStore;
  log(line: string): void;
  /** The last listing of the intents repo, and the open proposals (LOOP-92). */
  listing(): Listing | null;
  proposed(): ProposedPr[];
  /** OBV-12: a failed run is a fault of the loop; a good one closes it. */
  health?: { fail(kind: string, error: string, now: number): void; ok(kind: string): void };
  /** OBV-9: the owner's steering text, when it exists. */
  steering?: () => string | null;
  userHome?: string;
  towercabExe?: string;
}

interface Running {
  handle: ChildHandle;
  run: number;
  trigger: string;
  stdout: string;
  stderr: string;
  startMono: number;
  budget: number;
  ids: Set<string>;
  cut: string[];
  exit: { code: number | null; signal: string | null } | null;
  timedOut: boolean;
  stopped: boolean;
}

const read = (p: string): string => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};

export class Observer {
  private d: ObserverDeps;
  private running: Running | null = null;
  private swept = false;

  constructor(d: ObserverDeps) {
    this.d = d;
  }

  /** A run is going: the loop is not idle and does not restart or update. */
  busy(): boolean {
    return this.running !== null;
  }

  /** Shutdown: a running child is stopped and its run marked failed. */
  async stop(): Promise<void> {
    const r = this.running;
    if (!r) return;
    r.stopped = true;
    r.handle.kill("SIGTERM");
    await r.handle.done.catch(() => undefined);
    this.running = null;
    finishRun(this.d.db, r.run, {
      ended: this.d.clock.now(),
      cost: 0,
      outcome: "failed",
      findings: 0,
      proposals: 0,
      comments: 0,
      dropped: [],
      detail: { held: [], seen: [], why: "stopped by a shutdown" },
    });
  }

  /** One pass: reap a finished run, or look for a reason to start one. Never throws. */
  async pass(): Promise<void> {
    try {
      const { db, clock } = this.d;
      const now = clock.now();
      reloadObserver(this.d.config);
      if (!this.swept) {
        this.swept = true;
        failStale(db, now);
      }
      if (this.running) {
        await this.watch();
        return;
      }
      if (!this.d.config.observer.enabled) return;
      scanEvents(db, this.d.config, now);
      prune(db, now);
      const trigger = nextTrigger(db, this.d.config, now);
      if (trigger) await this.start(trigger);
      else queueReport(db, this.d.config, now, this.d.store.github());
    } catch (e) {
      this.d.log(`observer: ${(e as Error).message}`);
    }
  }

  private async watch(): Promise<void> {
    const r = this.running!;
    const agent = loadAgent("observer");
    const limit = agentTimeoutMin(agent, this.d.config) * 60_000;
    if (!r.exit && this.d.clock.mono() - r.startMono > limit) {
      r.timedOut = true;
      r.handle.kill("SIGKILL");
      await r.handle.done.catch(() => undefined);
    }
    if (!r.exit) return;
    this.running = null;
    await this.ended(r);
  }

  private async start(trigger: string): Promise<void> {
    const { db, clock, config, home } = this.d;
    const now = clock.now();
    const o = config.observer;
    const agent = loadAgent("observer");
    const listing = this.d.listing();
    const bundle = buildBundle({
      db,
      config,
      home,
      now,
      listing,
      proposed: this.d.proposed(),
      intentsRepo: this.d.store.github(),
    });
    const steering = (this.d.steering ?? readSteering)();
    const prompt = render("observer", {
      bundle: fence(bundle.text, "bundle"),
      steering: fence(steering?.trim() || "(none yet: rank by the evidence alone)", "steering"),
      repos: fence([...config.repos.values()].map((r) => `${r.name} (${r.github})`).join("\n"), "repos"),
      limit: String(o.maxProposalsPerWeek),
    });
    // OBV-10: one run is bounded by its own budget and by what is left of the day's.
    const left = o.dailyBudgetUsd - costToday(db, now);
    const budget = Math.max(
      0.01,
      Number(Math.min(agent.maxCostUsd ?? Number.POSITIVE_INFINITY, o.maxBudgetUsd, left).toFixed(2)),
    );
    markStarted(db, trigger, now);
    const run = startRun(db, trigger, now);
    let child: ChildSpec;
    let handle: ChildHandle;
    try {
      const runsDir = home.runs("observer");
      const cwd = join(runsDir, "empty");
      mkdirSync(cwd, { recursive: true });
      const spec: ClaudeRun = {
        kind: "observer",
        model: o.model ?? config.agent.model,
        cwd,
        runsDir,
        n: run,
        prompt,
        agent: "observer",
        schema: SCHEMAS.observer,
        session: { mode: "none", id: "" },
        budgetUsd: budget,
        claudeMd: "",
        grants: { domains: [], paths: [], open: false },
        cacheEnv: {},
        config,
      };
      child = {
        ...prepareRun(spec, {
          towercabExe: this.d.towercabExe ?? join(checkoutRoot(), "bin", "towercab"),
          home: this.d.userHome ?? homedir(),
        }),
        slot: false,
      };
      handle = this.d.tools.spawn(child);
    } catch (e) {
      this.fail(run, `couldn't start: ${(e as Error).message}`, 0);
      return;
    }
    const r: Running = {
      handle,
      run,
      trigger,
      stdout: child.stdout,
      stderr: child.stderr,
      startMono: clock.mono(),
      budget,
      ids: bundle.ids,
      cut: bundle.cut,
      exit: null,
      timedOut: false,
      stopped: false,
    };
    this.running = r;
    void handle.done.then((exit) => {
      r.exit = exit;
    });
  }

  /** OBV-12: a failed run is recorded, raised as a fault of kind `observer`, and retried at the next trigger. */
  private fail(run: number, why: string, cost: number): void {
    const { db, clock } = this.d;
    const now = clock.now();
    finishRun(db, run, {
      ended: now,
      cost,
      outcome: "failed",
      findings: 0,
      proposals: 0,
      comments: 0,
      dropped: [],
      detail: { held: [], seen: [], why },
    });
    this.d.log(`observer: run ${run} failed: ${why}`);
    this.d.health?.fail(FAULT, why, now);
  }

  private async ended(r: Running): Promise<void> {
    const { db, clock, config } = this.d;
    if (r.stopped) return;
    if (r.timedOut) return this.fail(r.run, "it ran out of time", 0);
    const end = parseRun(read(r.stdout), read(r.stderr), r.exit!.code, {
      model: config.observer.model ?? config.agent.model,
      now: new Date(clock.now() * 1000),
      home: this.d.userHome ?? homedir(),
    });
    const used = "result" in end ? end.result : null;
    const cost = used?.costUsd ?? 0;
    if (end.kind === "budget") {
      finishRun(db, r.run, {
        ended: clock.now(),
        cost,
        outcome: "capped",
        findings: 0,
        proposals: 0,
        comments: 0,
        dropped: [],
        detail: { held: [], seen: [], why: "its budget was used up" },
      });
      this.d.health?.ok(FAULT);
      return;
    }
    if (end.kind !== "ok") return this.fail(r.run, runEndLine(end), cost);
    // OBV-1: only a result that matches the schema reaches the code below; anything else opens nothing.
    const parsed = parseResult("observer", end.result.structuredOutput);
    if (!parsed.ok) return this.fail(r.run, `its answer was not usable: ${parsed.why}`, cost);
    await this.act(r, parsed.value.findings, cost);
  }

  /** OBV-4..8, OBV-11: check the findings, then open proposals and post comments, and nothing else. */
  private async act(r: Running, findings: ObserverFinding[], cost: number): Promise<void> {
    const { db, clock, config } = this.d;
    const now = clock.now();
    const listing = this.d.listing();
    const intentsRepo = this.d.store.github();
    const judged = judge(findings, {
      config,
      ids: r.ids,
      listing,
      proposed: this.d.proposed(),
      intentsRepo,
      recent: proposalsSince(db, now - WEEK_S),
      earlier: proposalsSince(db, 0),
    });
    const deps = {
      config,
      home: this.d.home,
      tools: this.d.tools,
      github: this.d.github,
      store: this.d.store,
      now,
    };
    const counts = { proposals: 0, comments: 0 };
    const taken = new Set<string>();
    const done = (why?: string): Finished => ({
      ended: clock.now(),
      cost,
      outcome: why ? "failed" : "done",
      findings: findings.length,
      proposals: counts.proposals,
      comments: counts.comments,
      dropped: judged.dropped,
      detail: {
        held: judged.held.map((f) => ({ title: f.title })),
        seen: judged.seen,
        ...(why ? { why } : {}),
      },
    });
    try {
      for (const [n, f] of judged.propose.entries()) {
        const o = await openProposal(deps, r.run, n, f, listing, taken);
        recordProposal(db, {
          pr: o.pr,
          intent: o.intent,
          run: r.run,
          at: now,
          title: f.title,
          evidence: JSON.stringify(f.evidence.map((e) => e.id)),
        });
        counts.proposals++;
        this.d.log(`observer: proposed ${f.title} (${intentsRepo}#${o.pr})`);
      }
      for (const c of judged.comments) {
        await commentEvidence(deps, c.target, c.finding);
        counts.comments++;
      }
    } catch (e) {
      const why = (e as Error).message;
      finishRun(db, r.run, done(why));
      this.d.log(`observer: run ${r.run} failed: ${why}`);
      this.d.health?.fail(FAULT, why, clock.now());
      return;
    }
    finishRun(db, r.run, done());
    this.d.health?.ok(FAULT);
  }
}
