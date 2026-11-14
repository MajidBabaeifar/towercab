// LOOP-78: the loop's driver for the parts of multi-repo missions. Each part is stepped, spawned and reaped
// like a mission of its own, by the same stage handlers (through `project`); what they report goes to the
// part (`applyPart`). Children, polls and slots are keyed by `unitKey`.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createCheckout, ensureClone } from "./checkout.ts";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import type { ChildEnd, Clock, Ctx, Handlers, Progress } from "./handlers.ts";
import type { ApplyCtx } from "./machine.ts";
import { getMission, type Mission } from "./mission.ts";
import { applyPart, partCtx, patchPart, project, stopForCap } from "./partrun.ts";
import { capReached, inPartStages, type PartState, partsOf, unitKey } from "./parts.ts";
import { cloneOf } from "./pipeline/common.ts";
import type { ChildHandle } from "./tools.ts";

interface PartRun {
  handle: ChildHandle;
  spec: { kind: string; slot: boolean; timeoutMs?: number; stdout: string; stderr: string; model?: string };
  startMono: number;
  exit: { code: number | null; signal: string | null } | null;
  termAt: number | null;
  timedOut: boolean;
  repo: string;
  mission: number;
  stage: string;
  step: string;
}

export interface PartHost {
  db: Db;
  config: Config;
  clock: Clock;
  handlers: Handlers;
  log(line: string): void;
  ctx(timeouts: boolean): Ctx;
  applyCtx(): ApplyCtx;
  lock<T>(fn: () => Promise<T>): Promise<T>;
  /** Missions that are not finished. */
  unfinished(): Mission[];
  /** No new work starts (a pause, a drain, a moved checkout). */
  holding(): boolean;
  /** Runs holding a slot, all missions together. */
  slotsUsed(): number;
}

const KILL_AFTER_MS = 10_000;

export class PartDriver {
  private children = new Map<string, PartRun>();
  private pollAt = new Map<string, number>();
  private host: PartHost;
  constructor(host: PartHost) {
    this.host = host;
  }

  /** Runs of parts that hold a slot (LOOP-78: they count in the workers of their repos and in `parallel`). */
  slots(): number {
    return [...this.children.values()].filter((r) => r.spec.slot && !r.exit).length;
  }

  running(): number {
    return this.children.size;
  }

  killAll(sig: NodeJS.Signals): void {
    for (const r of this.children.values()) if (!r.exit) r.handle.kill(sig);
  }

  private get now(): number {
    return this.host.clock.now();
  }

  private inRepo(repo: string): number {
    return [...this.children.values()].filter((r) => r.repo === repo && !r.exit).length;
  }

  async pass(timeouts: boolean): Promise<void> {
    this.enforceTimeouts();
    await this.reap(timeouts);
    if (this.host.holding()) return;
    for (const listed of this.host.unfinished()) {
      if (!inPartStages(listed)) continue;
      let m = listed;
      // One cap for the whole intent: once reached every part stops and the owner is asked once.
      if (capReached(this.host.config.agent.maxBudgetUsd, m)) {
        stopForCap(this.host.applyCtx(), m, "the intent's runs used up its budget");
        continue;
      }
      for (const part of partsOf(m)) {
        m = getMission(this.host.db, m.id) ?? m;
        if (!inPartStages(m)) break;
        const p = partsOf(m).find((x) => x.repo === part.repo);
        if (!p) continue;
        await this.stepPart(m, p, timeouts);
      }
    }
  }

  private async stepPart(m: Mission, p: PartState, timeouts: boolean): Promise<void> {
    const key = unitKey(m, p.repo);
    if (p.atGate || p.merged || p.waiting !== null || this.children.has(key)) return;
    if ((Number(p.cols?.retry_at) || 0) > this.now) return;
    if ((this.pollAt.get(key) ?? 0) > this.now) return;
    const h = this.host.handlers[p.stage as Mission["stage"]];
    if (!h) return;
    const pm = project(m, p);
    const cx = partCtx(this.host.ctx(timeouts), p.repo);
    // The part's own checkout of its repo, made before its first step (LOOP-8).
    const dir = cx.checkout(pm);
    if (!existsSync(join(dir, ".git"))) {
      try {
        await this.host.lock(async () => {
          const repo = cx.repo(pm);
          await ensureClone(cx.tools, cloneOf(cx, pm), repo, await cx.github.gitAuth(repo.github));
          await createCheckout(cx.tools, cloneOf(cx, pm), dir, repo.base, pm.branch);
        });
      } catch (e) {
        this.host.log(`${m.intent} part ${p.repo}: no checkout yet: ${(e as Error).message}`);
        this.pollAt.set(key, this.now + 5);
        return;
      }
    }
    await this.drive(m, p, () => h.step(cx, pm));
  }

  private async drive(m: Mission, p: PartState, call: () => Promise<Progress>): Promise<void> {
    const { db } = this.host;
    const key = unitKey(m, p.repo);
    let prog: Progress;
    try {
      prog = await this.host.lock(call);
    } catch (e) {
      const message = (e as Error).message;
      this.host.log(`${m.intent} part ${p.repo}: ${p.stage}: ${(e as Error).stack ?? message}`);
      const fresh = getMission(db, m.id) ?? m;
      const envFault = (e as { fault?: unknown }).fault !== undefined;
      applyPart(this.host.applyCtx(), fresh, p.repo, {
        event: envFault ? "env_fail" : "crash",
        why: message,
      });
      return;
    }
    const cur = getMission(db, m.id) ?? m;
    const part = partsOf(cur).find((x) => x.repo === p.repo) ?? p;
    if ("done" in prog) {
      applyPart(this.host.applyCtx(), cur, p.repo, prog.done);
      this.pollAt.delete(key);
    } else if ("poll" in prog) {
      this.pollAt.set(key, this.now + prog.poll);
    } else {
      await this.start(cur, part, prog);
    }
  }

  private async start(m: Mission, p: PartState, prog: Extract<Progress, { spawn: unknown }>): Promise<void> {
    const key = unitKey(m, p.repo);
    const s = prog.spawn;
    const workers = this.host.config.repos.get(p.repo)?.workers ?? 1;
    if (
      s.slot &&
      (this.host.slotsUsed() >= this.host.config.agent.parallel || this.inRepo(p.repo) >= workers)
    ) {
      this.pollAt.set(key, this.now + 1);
      return;
    }
    const handle = this.host.ctx(true).tools.spawn(s);
    const r: PartRun = {
      handle,
      spec: s,
      startMono: this.host.clock.mono(),
      exit: null,
      termAt: null,
      timedOut: false,
      repo: p.repo,
      mission: m.id,
      stage: p.stage,
      step: p.step,
    };
    this.children.set(key, r);
    void handle.done.then((exit) => {
      r.exit = exit;
    });
    patchPart(
      { db: this.host.db, now: this.now },
      m.id,
      p.repo,
      { ...(prog.launched ?? {}), child_pid: handle.pid, child_kind: s.kind, child_since: this.now },
      { launched: p.step },
    );
  }

  private enforceTimeouts(): void {
    const mono = this.host.clock.mono();
    for (const r of this.children.values()) {
      if (r.exit) continue;
      if (r.termAt !== null) {
        if (mono - r.termAt > KILL_AFTER_MS) r.handle.kill("SIGKILL");
        continue;
      }
      if (r.spec.timeoutMs !== undefined && mono - r.startMono > r.spec.timeoutMs) {
        r.timedOut = true;
        r.termAt = mono;
        r.handle.kill("SIGTERM");
      }
    }
  }

  private async reap(timeouts: boolean): Promise<void> {
    for (const [key, r] of [...this.children]) {
      if (!r.exit) continue;
      this.children.delete(key);
      const m = getMission(this.host.db, r.mission);
      const p = m ? partsOf(m).find((x) => x.repo === r.repo) : undefined;
      if (!m || !p || !inPartStages(m) || p.stage !== r.stage || p.step !== r.step) continue;
      const runMs = this.host.clock.mono() - r.startMono;
      patchPart({ db: this.host.db, now: this.now }, m.id, p.repo, {
        child_pid: null,
        child_kind: null,
        child_since: null,
        step_secs: Number(p.cols?.step_secs ?? 0) + runMs / 1000,
      });
      const fresh = getMission(this.host.db, m.id)!;
      const part = partsOf(fresh).find((x) => x.repo === r.repo)!;
      const h = this.host.handlers[part.stage as Mission["stage"]];
      if (!h) continue;
      const end: ChildEnd = {
        ...r.exit,
        timedOut: r.timedOut,
        runMs,
        stdout: r.spec.stdout,
        stderr: r.spec.stderr,
      };
      const cx = partCtx(this.host.ctx(timeouts), part.repo);
      const pm = project(fresh, part);
      await this.drive(fresh, part, () => h.finish(cx, pm, end));
    }
  }
}
