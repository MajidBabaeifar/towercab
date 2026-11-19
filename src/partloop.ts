// LOOP-78: the loop's driver for the parts of multi-repo missions. Each part is stepped, spawned and reaped
// like a mission of its own, by the same stage handlers (through `project`); what they report goes to the
// part (`applyPart`). Children, polls and slots are keyed by `unitKey`.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createCheckout, ensureClone } from "./checkout.ts";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { freezeAge, freezes, liftFreeze, takeFreeze } from "./freeze.ts";
import type { ChildEnd, Clock, Ctx, Handlers, Progress } from "./handlers.ts";
import { type ApplyCtx, apply } from "./machine.ts";
import { dataOf, getMission, type Mission, update } from "./mission.ts";
import { applyPart, partCtx, patchPart, project, stopForCap } from "./partrun.ts";
import {
  capReached,
  currentPart,
  freezeDue,
  freezeOver,
  inLanding,
  inPartStages,
  isMulti,
  type PartState,
  partsOf,
  unitKey,
} from "./parts.ts";
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

  /** Stop part runs the way the missions' are: SIGTERM, then SIGKILL for those still there after `ms`. */
  async stopAll(ms: number): Promise<void> {
    const live = [...this.children.values()].filter((r) => !r.exit);
    for (const r of live) r.handle.kill("SIGTERM");
    const ended = await Promise.all(
      live.map((r) =>
        Promise.race([
          r.handle.done.then(() => true),
          new Promise<boolean>((x) => setTimeout(() => x(false), ms)),
        ]),
      ),
    );
    for (const [i, r] of live.entries()) if (!ended[i]) r.handle.kill("SIGKILL");
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
    this.sweepFreezes();
    this.askAboutFreezes();
    if (this.host.holding()) return;
    for (const listed of this.host.unfinished()) {
      // LOOP-80: the owner approved the landing as a whole; the parts start to merge.
      if (listed.stage === "approval:merge" && isMulti(listed) && dataOf(listed).ownerApproved === true) {
        apply(this.host.applyCtx(), listed, { event: "code_merged", why: "the owner approved the landing" });
        continue;
      }
      if (inLanding(listed)) {
        await this.land(listed, timeouts);
        continue;
      }
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

  /** LOOP-80: the handler of the part's stage; while the mission merges, the part's stage is the merge. */
  private handlerOf(m: Mission, p: PartState) {
    return this.host.handlers[(m.stage === "merge" ? "merge" : p.stage) as Mission["stage"]];
  }

  /**
   * LOOP-79, LOOP-80: the parts land one at a time in the plan's order. Merging starts once the owner has
   * approved where that was needed and the freeze of all the repos is taken; then the part whose turn it is
   * merges, and after the last merge each part deploys and is checked live.
   */
  private async land(listed: Mission, timeouts: boolean): Promise<void> {
    let m = listed;
    if (m.stage === "merge") {
      const ready = this.readyToLand(m);
      if (!ready) return;
      m = ready;
    }
    const p = currentPart(m, partsOf(m));
    if (p) await this.stepPart(m, p, timeouts);
  }

  private readyToLand(m: Mission): Mission | null {
    const { db } = this.host;
    const parts = partsOf(m);
    // Landing starts once every part has passed its checks (merged ones from an earlier round count).
    if (!parts.every((p) => p.atGate || p.merged)) return null;
    // The owner's approval is asked for the intent as a whole, once every part is ready.
    if (parts.some((p) => p.data?.needsApproval === true) && dataOf(m).landApproved !== true) {
      apply(this.host.applyCtx(), m, {
        event: "wait",
        waiting: "review and merge PR",
        why: `Every part is built and checked. Approve to land them in order: ${parts.map((p) => p.repo).join(", ")}.`,
      });
      return null;
    }
    const repos = parts.map((p) => p.repo);
    const first = freezeAge(db, m.id, this.now) === null;
    const taken = takeFreeze(db, m.id, repos, this.now);
    if (!taken.ok) {
      const why = `waiting for the freeze of ${taken.repo}`;
      if (m.why !== why) update(db, m.id, { why }, this.now);
      return null;
    }
    if (first) {
      db.run(
        "INSERT OR IGNORE INTO outbox (key, mission, text, created) VALUES (?, ?, ?, ?)",
        `freeze:${m.id}:${this.now}`,
        m.id,
        `Merges are frozen in ${repos.join(", ")} while ${m.intent} lands its parts. Nothing else merges there until it is live.`,
        this.now,
      );
    }
    return getMission(db, m.id) ?? m;
  }

  /** LOOP-81: a freeze that lasted `agent.freeze_wait` minutes (counted again from a `continue`) asks the owner. */
  private askAboutFreezes(): void {
    const { db } = this.host;
    const limit = this.host.config.agent.freezeWaitMin;
    for (const m of this.host.unfinished()) {
      if (!inLanding(m)) continue;
      const age = freezeAge(db, m.id, this.now);
      if (age === null) continue;
      const since = this.now - age;
      const counted = this.now - Math.max(since, Number(dataOf(m).freezeFrom) || 0);
      if (!freezeDue(counted, limit)) continue;
      const parts = partsOf(m)
        .map((p) => `${p.repo}: ${p.merged ? "merged" : "not merged"}, ${p.stage}`)
        .join("; ");
      apply(this.host.applyCtx(), m, {
        event: "wait",
        waiting: "freeze",
        why: `Merges have been frozen for ${Math.floor(counted / 60)} minutes. ${parts}.`,
      });
    }
  }

  /** LOOP-80: a freeze lifts when its mission is done, ended unverified, dropped or back in its parts. */
  private sweepFreezes(): void {
    const { db } = this.host;
    for (const f of freezes(db)) {
      const m = getMission(db, f.mission);
      if (m && !freezeOver(m)) continue;
      const repos = liftFreeze(db, f.mission);
      if (repos.length === 0) continue;
      db.run(
        "INSERT OR IGNORE INTO outbox (key, mission, text, created) VALUES (?, ?, ?, ?)",
        `freeze-lift:${f.mission}:${f.since}`,
        m ? f.mission : null,
        `Merges are unfrozen in ${repos.join(", ")}${m ? ` (${m.intent})` : ""}. Other changes there can merge again.`,
        this.now,
      );
    }
  }

  private async stepPart(m: Mission, p: PartState, timeouts: boolean): Promise<void> {
    const key = unitKey(m, p.repo);
    const landing = inLanding(m);
    if ((!landing && (p.atGate || p.merged)) || p.waiting !== null || this.children.has(key)) return;
    if ((Number(p.cols?.retry_at) || 0) > this.now) return;
    if ((this.pollAt.get(key) ?? 0) > this.now) return;
    const h = this.handlerOf(m, p);
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
      if (!m || !p || !(inPartStages(m) || inLanding(m)) || p.stage !== r.stage || p.step !== r.step)
        continue;
      const runMs = this.host.clock.mono() - r.startMono;
      patchPart({ db: this.host.db, now: this.now }, m.id, p.repo, {
        child_pid: null,
        child_kind: null,
        child_since: null,
        step_secs: Number(p.cols?.step_secs ?? 0) + runMs / 1000,
      });
      const fresh = getMission(this.host.db, m.id)!;
      const part = partsOf(fresh).find((x) => x.repo === r.repo)!;
      const h = this.handlerOf(fresh, part);
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
