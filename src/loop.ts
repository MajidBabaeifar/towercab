// The loop (LOOP-4..7, 11, 12, 17, 18): one pass every 5 s. Reads inputs, moves missions, starts
// work, sends messages. Single-threaded: children run detached and are reaped on the next pass.

import { readFileSync, rmSync, statSync } from "node:fs";
import { Inhibitor, woke } from "./awake.ts";
import { removeCheckout } from "./checkout.ts";
import { applyPending, paused } from "./commands.ts";
import type { Config } from "./config.ts";
import type { Db, SqlValue } from "./db.ts";
import { fixFor, Health } from "./faults.ts";
import {
  BackfillError,
  dueFeatures,
  type FeaturesDeps,
  prepareBackfill,
  recoverFeatures,
  runBackfill,
  StoppedError,
  setFeaturesRun,
} from "./features.ts";
import { retireBranch } from "./github/branches.ts";
import {
  approveRequested,
  intentEvents,
  prEvents,
  releaseRequested,
  reversalMarker,
  reversalRequested,
} from "./github/events.ts";
import { pollIssues } from "./github/issues.ts";
import {
  MORE_THAN_FILE,
  MORE_THAN_ONE,
  type ProposedCache,
  type ProposedPr,
  type ProposedState,
  readProposed,
} from "./github/proposed.ts";
import { closeIfOpen, type PrState, readPr } from "./github/prs.ts";
import { type ChildEnd, type Clock, type Ctx, EnvError, type GitHub, type Handlers } from "./handlers.ts";
import { readHead } from "./head.ts";
import type { Home } from "./home.ts";
import { removeFeature, setFeature } from "./intents/features.ts";
import { type Intent, type IntentStore, type Listing, SyncError } from "./intents/types.ts";
import {
  type ApplyCtx,
  apply,
  finished,
  isWait,
  isWorking,
  next,
  type Outcome,
  phaseOf,
  type Subject,
  waitInfo,
} from "./machine.ts";
import {
  dataOf,
  getMission,
  insertMission,
  label,
  type Mission,
  patchData,
  unfinished,
  unfinishedFor,
  update,
} from "./mission.ts";
import { sendDue } from "./outbox.ts";
import { decide, orphans, type PickState } from "./pick.ts";
import { readingReply, reverseRefusals } from "./pipeline/access.ts";
import type { PipeData } from "./pipeline/common.ts";
import { writeTicks } from "./pipeline/steps.ts";
import { isParked, priority } from "./priority.ts";
import { loadRepos, syncRepos } from "./repos.ts";
import { checkoutRoot } from "./service.ts";
import { aheadIn, bestReady, buildingIn, isReady } from "./slots.ts";
import { leftOf, type OwnerStep, unticked } from "./steps.ts";
import { type ChildHandle, KILL_AFTER_MS, killGroup, type Tools } from "./tools.ts";
import { budgetReached } from "./ui/state.ts";
import { checkUpdate, RESTART_CODE } from "./update.ts";

export const PASS_MS = 5_000;
const PR_POLL_S = 60;
const INTENTS_POLL_S = 60;
const UPDATE_POLL_S = 60;
/** INT-21: GitHub issues are listed every 5 minutes. */
export const ISSUES_POLL_S = 300;

export interface LoopDeps {
  config: Config;
  home: Home;
  db: Db;
  tools: Tools;
  clock: Clock;
  store: IntentStore;
  github: GitHub;
  handlers: Handlers;
  log(line: string): void;
  /** Delivers outbox rows (Telegram), or null. */
  sender: { send(text: string): Promise<void> } | null;
  /** Read one PR (tests fake it). */
  readPr?: (repo: string, n: number) => Promise<PrState>;
  /** Read the intents repo's proposed intents (LOOP-92; tests fake it). */
  readProposed?: () => Promise<ProposedPr[]>;
  /** Self-update (LOOP-35); off in tests. */
  selfUpdate?: boolean;
  /** The checkout this loop's code runs from (LOOP-105); default the one this file is in. */
  codeRoot?: string;
  /** INT-39: when a backfill run's time is up (default a real timer; tests resolve it themselves). */
  featuresDeadline?: (ms: number) => Promise<void>;
}

export interface LoopOpts {
  watch: boolean;
  /** `run --intent`: step only this intent, picked first. */
  intent?: string;
}

interface Running {
  handle: ChildHandle;
  spec: { kind: string; slot: boolean; timeoutMs?: number; stdout: string; stderr: string; model?: string };
  startMono: number;
  exit: { code: number | null; signal: string | null } | null;
  termAt: number | null;
  timedOut: boolean;
}

export interface PassReport {
  idle: boolean;
  stop: boolean;
  picked: string | null;
  woke: boolean;
  /** `run --intent`: the target's end, `<id>: <stage>[ · <waiting>]`. */
  target: string | null;
}

export class Loop {
  readonly d: LoopDeps;
  readonly health = new Health();
  readonly inhibitor: Inhibitor;
  private children = new Map<number, Running>();
  private pollAt = new Map<number, number>();
  private listing: Listing | null = null;
  private listingError: string | null = null;
  private lastIntentsPoll = 0;
  private lastIssuesPoll = 0;
  private issuesRun: Promise<void> | null = null;
  /** INT-39: the feature-list backfill running now, and how to stop it. */
  private featuresJob: Promise<void> | null = null;
  private featuresStop: (() => void) | null = null;
  /** Why the last issue poll failed (INT-21); while set, the other GitHub reads don't close the fault. */
  private issuesError: string | null = null;
  private lastPrPoll = new Map<number, number>();
  /** LOOP-92: the last good list of proposed intents, why the last read failed and when. */
  private proposed: ProposedPr[] | null = null;
  private proposedError: string | null = null;
  private proposedFailedAt: number | null = null;
  private lastProposedPoll = 0;
  private proposedCache: ProposedCache = new Map();
  private lastUpdate = 0;
  /** LOOP-105: the commit the checkout was at when this loop started, or null when unknown. */
  private startCommit: string | null = null;
  private last: { wall: number; mono: number } | null = null;
  private stopping = false;
  exitCode = 0;
  private opts: LoopOpts;
  private targetId: string | null = null;

  constructor(d: LoopDeps, opts: LoopOpts) {
    this.d = d;
    this.opts = opts;
    this.inhibitor = new Inhibitor(d.tools, d.log);
  }

  get now(): number {
    return this.d.clock.now();
  }

  applyCtx(): ApplyCtx {
    return { db: this.d.db, now: this.now, subject: (m) => this.subject(m), log: this.d.log };
  }

  subject(m: Mission): Subject {
    const i = this.intentOf(m.intent);
    const repo = this.d.config.repos.get(m.repo);
    const prNo = m.pr ?? m.plan_pr ?? m.spec_pr;
    let link: string | null = null;
    if (m.pr && repo) link = `https://github.com/${repo.github}/pull/${m.pr}`;
    else if (m.plan_pr && this.d.store.github())
      link = `https://github.com/${this.d.store.github()}/pull/${m.plan_pr}`;
    else if (m.spec_pr && repo) link = `https://github.com/${repo.github}/pull/${m.spec_pr}`;
    else if (i) link = this.d.store.url(i);
    void prNo;
    return { title: i?.title ?? m.intent, repo: m.repo, link };
  }

  intentOf(id: string): Intent | null {
    const l = this.listing;
    if (!l) return null;
    return l.open.find((i) => i.id === id) ?? l.done.find((i) => i.id === id) ?? null;
  }

  /** Startup (LOOP-7): a leftover `meta.running` means an unclean exit. */
  async open(): Promise<void> {
    const { db } = this.d;
    const prev = db.meta("running");
    if (prev) {
      this.d.log("the last run didn't exit cleanly; recovering");
      for (const m of unfinished(db)) {
        if (m.child_pid) killGroup(m.child_pid, "SIGKILL");
        if (m.busy) {
          const fresh = update(db, m.id, { child_pid: null, child_kind: null, child_since: null }, this.now);
          apply(this.applyCtx(), fresh, { event: "crash", why: "Towercab stopped while this step ran" });
        }
      }
    }
    db.setMeta("running", `${process.pid} ${Math.floor(this.now)}`);
    // LOOP-105: the code this loop runs is the checkout as it is now; the guard's question names it.
    this.startCommit = readHead(this.codeRoot());
    if (this.startCommit) db.setMeta("code_commit", this.startCommit);
    else db.delMeta("code_commit");
    loadRepos(this.d.config, db, this.now);
    recoverFeatures(db, this.now);
    await this.pollIntents(true);
    await this.pollProposed(true);
    this.startIssues(true);
  }

  private codeRoot(): string {
    return this.d.codeRoot ?? checkoutRoot();
  }

  /**
   * LOOP-105: the checkout's commit now when it is not the one this loop started from, else null. The
   * hook of a run is the checkout's code, so a loop that writes its files from older code must restart.
   */
  private codeMoved(): string | null {
    if (this.startCommit === null) return null;
    const now = readHead(this.codeRoot());
    return now !== null && now !== this.startCommit ? now : null;
  }

  /** LOOP-105: with the checkout moved and nothing running, exit 75 so systemd starts the current code. */
  private restartIfMoved(): void {
    if (this.stopping) return;
    const to = this.codeMoved();
    if (to === null || this.children.size > 0 || this.featuresJob !== null || this.issuesRun !== null) return;
    this.d.log(
      `the checkout moved from ${this.startCommit} to ${to}; restarting so the loop and its guard run the same code`,
    );
    this.stop(RESTART_CODE);
  }

  /** Clean exit: children get SIGTERM, then SIGKILL; their missions are `interrupted`. */
  async shutdown(): Promise<void> {
    await this.issuesIdle();
    this.stopFeatures();
    await this.featuresIdle();
    for (const [id, r] of this.children) {
      r.handle.kill("SIGTERM");
      const done = await Promise.race([
        r.handle.done.then(() => true),
        sleep(KILL_AFTER_MS).then(() => false),
      ]);
      if (!done) r.handle.kill("SIGKILL");
      const m = getMission(this.d.db, id);
      if (m && !finished(m.stage)) {
        const runS = (this.d.clock.mono() - r.startMono) / 1000;
        const fresh = update(
          this.d.db,
          m.id,
          { child_pid: null, child_kind: null, child_since: null, step_secs: m.step_secs + runS },
          this.now,
        );
        apply(this.applyCtx(), fresh, { event: "interrupted" });
      }
    }
    this.children.clear();
    this.inhibitor.stop();
    this.d.db.delMeta("running");
  }

  stop(code = 0): void {
    this.stopping = true;
    this.exitCode = code;
  }

  /** The pass loop until stopped (LOOP-12). */
  async run(): Promise<number> {
    await this.open();
    while (!this.stopping) {
      const r = await this.pass();
      if (r.stop) break;
      if (!this.opts.watch && r.idle) break;
      await sleep(PASS_MS);
    }
    await this.shutdown();
    return this.exitCode;
  }

  ctx(timeouts = true): Ctx {
    const d = this.d;
    return {
      config: d.config,
      home: d.home,
      db: d.db,
      tools: d.tools,
      clock: d.clock,
      store: d.store,
      github: d.github,
      timeouts,
      log: d.log,
      repo: (m) => {
        const r = d.config.repos.get(m.repo);
        if (!r) throw new Error(d.config.badRepos.get(m.repo) ?? `unknown repo ${m.repo}`);
        return r;
      },
      checkout: (m) => d.home.abs(m.checkout),
      runs: (m, stage) => d.home.runs(m.intent, stage),
      record: (m, step, set = {}, data) =>
        d.db.tx(() => {
          const cols: Record<string, SqlValue> = { ...set, step };
          if (step !== m.step) {
            cols.unclean = 0;
            cols.retries = 0;
            cols.step_secs = 0;
          }
          let fresh = update(d.db, m.id, cols, this.now);
          // A new step hasn't launched anything yet (LOOP-4).
          const launched = step !== m.step ? { launched: undefined } : {};
          if (data || step !== m.step)
            fresh = update(
              d.db,
              m.id,
              { data: JSON.stringify({ ...dataOf(fresh), ...data, ...launched }) },
              this.now,
            );
          return fresh;
        }),
    };
  }

  /** One pass. */
  async pass(): Promise<PassReport> {
    const { db, clock } = this.d;
    const report: PassReport = { idle: false, stop: false, picked: null, woke: false, target: null };
    const nowPoint = { wall: clock.now(), mono: clock.mono() };
    if (this.last && woke(this.last, nowPoint, PASS_MS / 1000)) {
      report.woke = true;
      this.pollAt.clear();
      this.lastPrPoll.clear();
      this.lastIntentsPoll = 0;
      this.lastProposedPoll = 0;
      this.lastIssuesPoll = 0;
      this.d.log("woke from suspend; polling everything before any timeout");
    }
    this.last = nowPoint;
    db.setMeta("last_pass", String(Math.floor(this.now)));
    db.setMeta("health", JSON.stringify(this.health.open()));
    // LOOP-68: repos added or removed since the last pass (by the CLI or the page).
    syncRepos(this.d.config, db);

    // Commands from the CLI and the UI.
    for (const c of await applyPending({
      db,
      store: this.d.store,
      applyCtx: this.applyCtx(),
      now: new Date(this.now * 1000),
    })) {
      this.d.log(`command ${c.id}: ${c.result}`);
    }

    await this.syncSteps();
    await this.reap();
    await this.enterDue();
    this.enforceTimeouts();
    await this.pollIntents(false);
    await this.pollProposed(false);
    await this.requeueKnownRepos();
    // LOOP-105: with the checkout moved, running children finish but nothing new starts.
    if (this.codeMoved() === null) this.startIssues(false);
    await this.pollPrs();
    this.releaseReady();
    await this.stepDue(!report.woke);
    if (
      !paused(db) &&
      !this.health.blocked(this.now) &&
      !budgetReached(db, this.d.config, this.now) &&
      this.codeMoved() === null
    ) {
      report.picked = await this.pick();
      await this.startFeatures();
    }
    await this.selfUpdate();
    this.restartIfMoved();
    await this.sendMessages();

    // A change waiting days on the owner's steps is not work: the machine may sleep and the loop is idle.
    const working = (m: Mission) => isWorking(m.stage) && !(m.stage === "steps" && m.waiting);
    const driven = unfinished(db).find((m) => working(m) && !m.held && !this.cooling(m));
    this.inhibitor.update(driven ? `${driven.intent} ${driven.stage}` : null, clock.mono());

    const live = unfinished(db).filter((m) => working(m) && !this.cooling(m));
    report.idle =
      this.children.size === 0 && this.featuresJob === null && live.length === 0 && report.picked === null;
    if (this.targetId) {
      const m = db.get<Mission>(
        "SELECT * FROM missions WHERE intent = ? ORDER BY id DESC LIMIT 1",
        this.targetId,
      );
      if (m && (finished(m.stage) || isWait(m.stage))) {
        report.target = `${m.intent}: ${m.stage}${m.waiting ? ` · ${m.waiting}` : ""}`;
        report.stop = true;
      }
    }
    if (this.stopping) report.stop = true;
    return report;
  }

  /** Children that ended → their handler's `finish` (LOOP-12). */
  private async reap(): Promise<void> {
    for (const [id, r] of [...this.children]) {
      if (!r.exit) continue;
      this.children.delete(id);
      const m = getMission(this.d.db, id);
      if (!m || finished(m.stage)) continue;
      const runMs = this.d.clock.mono() - r.startMono;
      const fresh = update(
        this.d.db,
        m.id,
        // `child_model` stays while `finish` reads the run (a limit cools the model that ran).
        { child_pid: null, child_kind: null, child_since: null, step_secs: m.step_secs + runMs / 1000 },
        this.now,
      );
      dropIfEmpty(r.spec.stderr);
      const end: ChildEnd = {
        ...r.exit,
        timedOut: r.timedOut,
        runMs,
        stdout: r.spec.stdout,
        stderr: r.spec.stderr,
      };
      const h = this.d.handlers[fresh.stage];
      if (!h) continue;
      // A Claude run that ended without a network or auth failure: Claude is reachable.
      await this.drive(fresh, () => h.finish(this.ctx(), fresh, end), r.spec.model !== undefined);
      if (!this.children.has(id)) update(this.d.db, id, { child_model: null }, this.now);
    }
  }

  /**
   * SHIP-22: ticks the owner made (the CLI and the page write them to the database) go to `plan.md`, and
   * the wait they finish continues. A failed write is tried again on the next pass; the tick counts meanwhile.
   */
  private async syncSteps(): Promise<void> {
    const { db } = this.d;
    for (const m of unfinished(db)) {
      const d = dataOf<{ steps?: OwnerStep[]; stepsDirty?: number }>(m);
      if (!d.steps?.length) continue;
      if (d.stepsDirty !== undefined) {
        try {
          await writeTicks(this.ctx(), m);
        } catch (e) {
          this.d.log(
            `${label(m)}: couldn't write the ticked steps to plan.md, retrying: ${(e as Error).message}`,
          );
        }
      }
      const cur = getMission(db, m.id) ?? m;
      if (
        cur.stage === "blocked" &&
        cur.waiting === "your steps first" &&
        unticked(d.steps, "before").length === 0
      ) {
        this.move(cur, { event: "answered", why: "your steps are done" });
      }
      // The intent shows how many are left (UI-163).
      const left = leftOf(d.steps, cur.waiting);
      const i = this.intentOf(cur.intent);
      if (i && cur.waiting && (i.stepsLeft ?? null) !== left && !i.done) {
        try {
          await this.d.store.update(cur.intent, "steps", (e) => {
            if (left) e.setField("steps_left", left);
            else e.removeField("steps_left");
          });
        } catch (e) {
          this.d.log(`${label(cur)}: couldn't update the steps left: ${(e as Error).message}`);
        }
      }
    }
  }

  /** Entry effects of every mission whose step is `enter` (LOOP-6), finished ones too. */
  private async enterDue(): Promise<void> {
    for (const m of this.d.db.all<Mission>("SELECT * FROM missions WHERE step = 'enter' ORDER BY id")) {
      try {
        await this.enter(m);
      } catch (e) {
        this.d.log(`${label(m)}: entering ${m.stage} failed, retrying next pass: ${(e as Error).message}`);
      }
    }
  }

  private async enter(m: Mission): Promise<void> {
    const { db, store } = this.d;
    // A move out of a stage kills that stage's child.
    const child = this.children.get(m.id);
    if (child) {
      child.handle.kill("SIGTERM");
      this.children.delete(m.id);
    }
    const newer =
      db.get<{ n: number }>("SELECT COUNT(*) AS n FROM missions WHERE intent = ? AND id > ?", m.intent, m.id)
        ?.n ?? 0;
    const intent = this.intentOf(m.intent);
    const replaced = m.stage === "stopped" && newer > 0;
    if (intent && !intent.done && !replaced) {
      const t =
        db.get<{ id: number }>("SELECT MAX(id) AS id FROM transitions WHERE mission = ?", m.id)?.id ?? 0;
      const mark = `Towercab-Entry: ${m.session} ${t}`;
      if (!(await store.hasMark(mark))) {
        const data = dataOf<{ dropped?: boolean; steps?: OwnerStep[] }>(m);
        const repo = this.d.config.repos.get(m.repo);
        const prUrl = (n: number | null, gh: string | null | undefined) =>
          n && gh ? `https://github.com/${gh}/pull/${n}` : null;
        await store.update(
          m.intent,
          m.stage,
          (e) => {
            if (m.stage === "stopped" && !data.dropped) {
              e.removeField("stage");
              e.removeField("waiting");
              return;
            }
            e.setField("stage", phaseOf(m.stage, m.from_stage));
            if (m.waiting && (isWait(m.stage) || m.stage === "steps")) e.setField("waiting", m.waiting);
            else e.removeField("waiting");
            // UI-163: how many of the owner's steps are left, while the change waits on them.
            const left = leftOf(data.steps, m.waiting);
            if (left) e.setField("steps_left", left);
            else e.removeField("steps_left");
            const spec = prUrl(m.spec_pr, repo?.github);
            const plan = prUrl(m.plan_pr, store.github());
            const code = prUrl(m.pr, repo?.github);
            if (spec) e.setField("spec_pr", spec);
            if (plan) e.setField("plan_pr", plan);
            if (code) e.setField("pr", code);
            if (m.stage === "pick") e.removeField("retry");
            // SHIP-21: merged but never checked live; a mission that reaches `done` has no such field.
            if (m.stage === "unverified") e.setField("verified", "no");
            else e.removeField("verified");
            if (m.stage === "done" || m.stage === "unverified") {
              const all = db.all<{ cost_usd: number; agent_secs: number }>(
                "SELECT cost_usd, agent_secs FROM missions WHERE intent = ?",
                m.intent,
              );
              e.setField("cost", Math.round(all.reduce((s, x) => s + x.cost_usd, 0) * 100) / 100);
              e.setField("agent_time", Math.round(all.reduce((s, x) => s + x.agent_secs, 0)));
              e.setField("attempts", all.length);
            }
          },
          mark,
        );
      }
    }
    if (!replaced) await this.featureLine(m, intent);
    if (replaced) await this.closeReplaced(m);
    else if (m.stage === "stopped") await this.retireStopped(m);
    if (finished(m.stage)) removeCheckout(this.d.home.abs(m.checkout));
    const set: Record<string, SqlValue> = { step: "" };
    if (m.stage === "merge" && paused(db)) set.held = 1;
    update(db, m.id, set, this.now);
  }

  /**
   * INT-38: the repo's feature list follows the mission: picked → its line "in progress", done → "live",
   * stopped (dropped or removed) → its line goes. Each edit is idempotent, so a retried entry repeats
   * it harmlessly; only a sync failure retries the entry, any other refusal is logged and skipped.
   */
  private async featureLine(m: Mission, intent: Intent | null): Promise<void> {
    if (!this.d.config.repos.has(m.repo)) return;
    const title = intent?.title ?? "";
    let fn: ((text: string | null) => string | null) | null = null;
    if (m.stage === "pick" && intent)
      fn = (t) => setFeature(t, m.repo, { intent: m.intent, title, status: "in progress" });
    else if (m.stage === "done")
      fn = (t) => setFeature(t, m.repo, { intent: m.intent, title, status: "live" });
    else if (m.stage === "stopped" || m.stage === "unverified") fn = (t) => removeFeature(t, m.intent);
    if (!fn) return;
    const what = m.stage === "pick" ? "start" : m.stage === "done" ? "live" : "drop";
    try {
      await this.d.store.editFeatures(m.repo, `${what} ${m.intent}`, fn);
    } catch (e) {
      if (e instanceof SyncError) throw e;
      this.d.log(`${label(m)}: the feature list of ${m.repo} wasn't changed: ${(e as Error).message}`);
    }
  }

  /** The mission's spec, plan and code PRs, with the repo each lives in. */
  private missionPrs(m: Mission): [string, number][] {
    const repo = this.d.config.repos.get(m.repo);
    const prs: [string | null | undefined, number | null][] = [
      [repo?.github, m.spec_pr],
      [this.d.store.github(), m.plan_pr],
      [repo?.github, m.pr],
    ];
    return prs.filter((p): p is [string, number] => Boolean(p[0] && p[1]));
  }

  /**
   * PIP-53, PIP-87: a replaced attempt's open PRs are closed, so only the new attempt's wait for
   * review, and their branches are deleted. A failure leaves the step at `enter`: retried next pass.
   */
  private async closeReplaced(m: Mission): Promise<void> {
    const why = `Towercab started this intent over (attempt ${m.attempt + 1}), so this PR is closed. The new attempt opens its own.`;
    await this.closeAndRetire(m, why);
  }

  /**
   * A mission that stopped without a replacement: after the owner closed a PR (PIP-88) the branches of
   * its closed PRs are deleted; after the intent was dropped or removed (PIP-87) its open PRs are
   * closed first.
   */
  private async retireStopped(m: Mission): Promise<void> {
    const last = this.d.db.get<{ event: string }>(
      "SELECT event FROM transitions WHERE mission = ? ORDER BY id DESC LIMIT 1",
      m.id,
    );
    if (last?.event === "closed") await this.closeAndRetire(m, null);
    else if (last?.event === "intent_removed") {
      await this.closeAndRetire(m, "Towercab closed this PR because the intent was dropped.");
    }
  }

  private async closeAndRetire(m: Mission, why: string | null): Promise<void> {
    const prs = this.missionPrs(m);
    if (why) for (const [github, n] of prs) await closeIfOpen(this.d.github, github, n, why);
    for (const [github, n] of prs) {
      const gone = await retireBranch(this.d.github, github, n, this.d.store.github());
      if (gone) this.d.log(`${label(m)}: deleted branch ${gone} of ${github}#${n}`);
    }
  }

  private enforceTimeouts(): void {
    const mono = this.d.clock.mono();
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

  /** The intents repo (LOOP-18): every 60 s; events for missions, orphaned stages cleared. */
  private async pollIntents(force: boolean): Promise<void> {
    if (!force && this.now - this.lastIntentsPoll < INTENTS_POLL_S) return;
    this.lastIntentsPoll = this.now;
    try {
      this.listing = await this.d.store.list();
      this.listingError = null;
      this.githubOk();
    } catch (e) {
      this.listingError = (e as Error).message;
      this.health.fail("github", this.listingError, this.now);
      return;
    }
    const listing = this.listing;
    const db = this.d.db;
    for (const m of unfinished(db)) {
      if (m.step === "enter") continue;
      const intent = listing.open.find((i) => i.id === m.intent) ?? null;
      const unreadable = listing.unreadable.some((u) => u.id === m.intent);
      if (!intent && unreadable) continue;
      const o = intentEvents(m, intent);
      if (o) this.move(m, o);
    }
    const busy = new Set(unfinished(db).map((m) => m.intent));
    // `retry: fresh` on an intent with no mission: queue it again (LOOP-18).
    for (const i of listing.open) {
      if (i.retry !== "fresh" || busy.has(i.id)) continue;
      try {
        await this.d.store.update(i.id, "retry", (e) => {
          e.removeField("retry");
          e.removeField("stage");
          e.removeField("waiting");
        });
      } catch (e) {
        this.d.log(`retry ${i.id}: ${(e as Error).message}`);
      }
    }
    for (const id of orphans(listing, busy)) {
      try {
        await this.d.store.update(id, "unstage", (e) => e.removeField("stage"));
      } catch (e) {
        this.d.log(`unstage ${id}: ${(e as Error).message}`);
      }
    }
  }

  /**
   * LOOP-68: an intent that waits for an unknown repo is queued again once the repo is known, and
   * the intents are read again so this pass can pick it.
   */
  private async requeueKnownRepos(): Promise<void> {
    const repos = this.d.config.repos;
    const known = (this.listing?.open ?? []).filter(
      (i) => i.waiting === "unknown repo" && repos.has(i.repo) && !unfinishedFor(this.d.db, i.id),
    );
    let queued = 0;
    for (const i of known) {
      try {
        await this.d.store.update(i.id, "repo known", (e) => {
          if (e.intent.waiting === "unknown repo") e.removeField("waiting");
        });
        queued++;
        this.d.log(`${i.id}: its repo ${i.repo} is known now; queued again`);
      } catch (e) {
        this.d.log(`${i.id}: ${(e as Error).message}`);
      }
    }
    if (queued > 0) await this.pollIntents(true);
  }

  /** A GitHub read worked; the fault closes unless the issue poll is still failing (INT-21). */
  private githubOk(): void {
    if (this.issuesError === null && this.proposedError === null) this.health.ok("github");
  }

  /**
   * LOOP-92, LOOP-93: the intents repo's open PRs that add an intent, every 60 s and on start (or at
   * once when the page acted on one). A failure keeps the last list. A PR seen for the first time
   * queues its one message; the first successful read only marks what is already open as seen.
   */
  private async pollProposed(force: boolean): Promise<void> {
    const asked = this.d.db.meta("proposed:poll") !== null;
    if (asked) this.d.db.delMeta("proposed:poll");
    if (!force && !asked && this.now - this.lastProposedPoll < INTENTS_POLL_S) return;
    const repo = this.d.store.github();
    if (!repo && !this.d.readProposed) return;
    this.lastProposedPoll = this.now;
    let list: ProposedPr[];
    try {
      list = this.d.readProposed
        ? await this.d.readProposed()
        : await readProposed(this.d.github, repo!, this.proposedCache, (await this.d.github.bot()).login);
    } catch (e) {
      this.proposedError = (e as Error).message;
      this.proposedFailedAt = this.now;
      this.health.fail("github", this.proposedError, this.now);
      this.d.log(`reading the proposed intents failed: ${this.proposedError}`);
      return;
    }
    this.proposed = list;
    this.proposedError = null;
    this.proposedFailedAt = null;
    if (this.listingError === null) this.githubOk();
    const db = this.d.db;
    db.tx(() => {
      const seeded = db.meta("proposed:seeded") !== null;
      for (const p of list) {
        if (db.meta(`proposed:seen:${p.number}`) !== null) continue;
        db.setMeta(`proposed:seen:${p.number}`, String(Math.floor(this.now)));
        if (!seeded) continue;
        const i = p.intent;
        const head = `Proposed intent: ${i?.title ?? p.title}${
          i ? ` (${i.repo}), ${this.proposedPriority(i)}` : ""
        }`;
        const port = this.d.config.ui.port;
        const githubOnly = p.reason === MORE_THAN_ONE || p.reason === MORE_THAN_FILE;
        const link = port && !githubOnly ? `http://localhost:${port}/#proposed-${p.number}` : p.url;
        db.run(
          "INSERT OR IGNORE INTO outbox (key, mission, text, created) VALUES (?, NULL, ?, ?)",
          `proposed:${p.number}`,
          `${head}\n${link}`,
          this.now,
        );
      }
      if (!seeded) db.setMeta("proposed:seeded", String(Math.floor(this.now)));
    });
  }

  private proposedPriority(i: { u: number | null; i: number | null }): string {
    const p = priority(i.u, i.i);
    return isParked(p, this.d.config.intents.cutoff) ? "would be parked" : `priority ${p}`;
  }

  /** For the page (UI-184) and the actions (INT-53). */
  proposedState(): ProposedState {
    return { list: this.proposed ?? [], error: this.proposedError, failedAt: this.proposedFailedAt };
  }

  /** Resolves when no issue poll is running (tests and shutdown wait for it). */
  async issuesIdle(): Promise<void> {
    while (this.issuesRun) await this.issuesRun;
  }

  /**
   * INT-21: the GitHub issue poll, every 300 s of the loop's clock and on start. It runs on its own
   * (scoring takes minutes) and never more than once at a time.
   */
  private startIssues(force: boolean): void {
    if (this.issuesRun || !this.d.config.github) return;
    if (!force && this.now - this.lastIssuesPoll < ISSUES_POLL_S) return;
    this.lastIssuesPoll = this.now;
    const run = pollIssues({
      config: this.d.config,
      home: this.d.home,
      tools: this.d.tools,
      clock: this.d.clock,
      store: this.d.store,
      github: this.d.github,
      log: this.d.log,
      busy: () => new Set(unfinished(this.d.db).map((m) => m.intent)),
    }).then(
      () => {
        this.issuesError = null;
        if (this.listingError === null && this.proposedError === null) this.health.ok("github");
      },
      (e: Error) => {
        this.issuesError = e.message;
        this.health.fail("github", e.message, this.now);
        this.d.log(`reading GitHub issues failed: ${e.message}`);
      },
    );
    this.issuesRun = run.finally(() => {
      this.issuesRun = null;
    });
  }

  /** Resolves when no feature-list backfill is running (tests and shutdown wait for it). */
  async featuresIdle(): Promise<void> {
    while (this.featuresJob) await this.featuresJob;
  }

  /** Shutdown: a running backfill's child is killed and the backfill is asked for again. */
  private stopFeatures(): void {
    this.featuresStop?.();
  }

  /**
   * INT-39: the oldest asked-for backfill of a feature list, one at a time, on its own (it takes
   * minutes). Only when new work may start: not paused, no blocking problem, under the budget.
   */
  private async startFeatures(): Promise<void> {
    if (this.featuresJob) return;
    const db = this.d.db;
    const repo = dueFeatures(db)[0];
    if (repo === undefined) return;
    setFeaturesRun(db, repo, { state: "running", at: this.now });
    let stop!: () => void;
    const stopped = new Promise<void>((r) => {
      stop = r;
    });
    const deps: FeaturesDeps = {
      config: this.d.config,
      home: this.d.home,
      tools: this.d.tools,
      clock: this.d.clock,
      store: this.d.store,
      github: this.d.github,
      stop: stopped,
      ...(this.d.featuresDeadline ? { deadline: this.d.featuresDeadline } : {}),
    };
    // The clone's fetch and the checkout happen in the pass, never beside a mission's git step.
    let checkout: string;
    try {
      checkout = await prepareBackfill(deps, repo);
    } catch (e) {
      setFeaturesRun(db, repo, { state: "failed", at: this.now, why: (e as Error).message, cost: 0 });
      this.d.log(`feature list of ${repo}: reading the repo failed: ${(e as Error).message}`);
      return;
    }
    this.featuresStop = stop;
    const run = runBackfill(deps, repo, checkout).then(
      (r) => {
        setFeaturesRun(db, repo, { state: "done", at: this.now, n: r.n, cost: r.cost });
        this.d.log(`feature list of ${repo}: ${r.n} live features read from the repo`);
      },
      (e: Error) => {
        if (e instanceof StoppedError) {
          setFeaturesRun(db, repo, { state: "due", at: this.now });
          return;
        }
        const cost = e instanceof BackfillError ? e.cost : 0;
        setFeaturesRun(db, repo, { state: "failed", at: this.now, why: e.message, cost });
        this.d.log(`feature list of ${repo}: reading the repo failed: ${e.message}`);
      },
    );
    this.featuresJob = run.finally(() => {
      this.featuresJob = null;
      this.featuresStop = null;
    });
  }

  /** PR reads (LOOP-18, PIP-21): every 60 s per mission with a PR. */
  private async pollPrs(): Promise<void> {
    const read = this.d.readPr ?? ((repo: string, n: number) => readPr(this.d.github, repo, n));
    for (const m of unfinished(this.d.db)) {
      if (m.step === "enter" || (!m.spec_pr && !m.plan_pr && !m.pr)) continue;
      // UI-106: the page acted on this PR, so read it now instead of at the next minute.
      const asked = this.d.db.meta(`poll:${m.id}`) !== null;
      if (asked) this.d.db.delMeta(`poll:${m.id}`);
      else if (this.now - (this.lastPrPoll.get(m.id) ?? 0) < PR_POLL_S) continue;
      this.lastPrPoll.set(m.id, this.now);
      const repo = this.d.config.repos.get(m.repo);
      const intentsRepo = this.d.store.github();
      if (!repo) continue;
      try {
        const prs: { spec?: PrState; plan?: PrState; code?: PrState } = {};
        if (m.spec_pr) prs.spec = await read(repo.github, m.spec_pr);
        if (m.plan_pr && intentsRepo) prs.plan = await read(intentsRepo, m.plan_pr);
        if (m.pr) prs.code = await read(repo.github, m.pr);
        this.githubOk();
        const approve = approveRequested(m, prs, this.d.github.me);
        if (approve !== null) {
          const target = approve === m.plan_pr ? intentsRepo! : repo.github;
          const r = await this.d.github.gh(target, [
            "pr",
            "merge",
            String(approve),
            "--squash",
            "-R",
            target,
          ]);
          this.d.log(
            `${label(m)}: the owner approved PR ${approve}; ${r.code === 0 ? "merged" : `merge refused: ${r.stderr.trim()}`}`,
          );
          this.lastPrPoll.delete(m.id);
          continue;
        }
        const bot = (await this.d.github.bot()).login;
        for (const ask of releaseRequested(m, prs, this.d.github.me, bot)) {
          const target = ask.kind === "plan" ? intentsRepo! : repo.github;
          await this.d.github.gh(
            target,
            ["pr", "comment", String(ask.pr), "-R", target, "--body-file", "-"],
            {
              input: ask.reply,
            },
          );
        }
        // PIP-141: the owner's `allow <path>` reverses a refusal, when no worker holds the mission's data.
        let reversed = false;
        if (!this.children.has(m.id)) {
          for (const ask of reversalRequested(m, prs, this.d.github.me, bot)) {
            let said: string;
            try {
              const r = reverseRefusals(dataOf(m) as PipeData, ask.paths);
              const live = unfinishedFor(this.d.db, m.intent) ?? m;
              if (live.stage === "blocked")
                this.move(live, { event: "answered", text: ask.text, data: r.patch });
              else patchData(this.d.db, live, r.patch, this.now);
              said = readingReply({ allowed: r.moved, refused: [], undecided: [] });
              reversed = true;
            } catch (e) {
              said = (e as Error).message;
            }
            const target = ask.kind === "plan" ? intentsRepo! : repo.github;
            await this.d.github.gh(
              target,
              ["pr", "comment", String(ask.pr), "-R", target, "--body-file", "-"],
              {
                input: `${reversalMarker(ask.commentId)}\n${said}`,
              },
            );
            break;
          }
        }
        if (reversed) {
          this.lastPrPoll.delete(m.id);
          continue;
        }
        const o = prEvents(pastMerges(m, prs), prs, this.d.github.me, bot);
        if (!o) continue;
        const running = this.children.has(m.id);
        if (running && !["code_merged", "spec_merged", "plan_merged", "closed"].includes(o.event)) continue;
        this.move(m, o);
      } catch (e) {
        const msg = (e as Error).message;
        this.health.fail("github", msg, this.now);
        this.d.log(`${label(m)}: reading its PRs failed: ${msg}`);
      }
    }
  }

  /** Missions whose step is due: their handler's `step` (LOOP-4). */
  private async stepDue(timeouts: boolean): Promise<void> {
    const { db } = this.d;
    const queued = this.queued();
    for (const m of unfinished(db)) {
      if (!isWorking(m.stage) || m.step === "enter" || m.held || this.children.has(m.id)) continue;
      // LOOP-105: no step of a loop whose checkout moved under it runs.
      if (this.codeMoved() !== null) break;
      if (queued.has(m.id) || this.cooling(m)) continue;
      if (m.retry_at && m.retry_at > this.now) continue;
      if ((this.pollAt.get(m.id) ?? 0) > this.now) continue;
      if (this.opts.intent && this.targetId && m.intent !== this.targetId) continue;
      const h = this.d.handlers[m.stage];
      if (!h) continue;
      const fresh = update(db, m.id, { busy: 1 }, this.now);
      await this.drive(fresh, () => h.step(this.ctx(timeouts), fresh));
    }
  }

  /** Call a handler and act on its progress. */
  private async drive(
    m: Mission,
    call: () => Promise<import("./handlers.ts").Progress>,
    claudeRun = false,
  ): Promise<void> {
    let p: import("./handlers.ts").Progress;
    try {
      p = await call();
    } catch (e) {
      const cur = getMission(this.d.db, m.id) ?? m;
      if (e instanceof EnvError) {
        this.health.fail(e.fault, e.message, this.now);
        this.move(cur, { event: "env_fail", why: e.message });
      } else {
        this.d.log(`${label(cur)}: ${cur.stage}: ${(e as Error).stack ?? (e as Error).message}`);
        this.move(cur, { event: "crash", why: (e as Error).message });
      }
      return;
    }
    const cur = getMission(this.d.db, m.id) ?? m;
    if ("done" in p) {
      // Only a Claude run's end closes a Claude fault: another mission's git step says nothing of it.
      if (claudeRun && p.done.event !== "env_fail") this.health.ok("claude");
      this.move(cur, p.done);
    } else if ("poll" in p) {
      this.pollAt.set(m.id, this.now + p.poll);
      update(this.d.db, m.id, { busy: 0 }, this.now);
    } else {
      let spec = p.spawn;
      // LOOP-105: the checkout moved while the step prepared its run (its rules file may be from this
      // older code): drop the run; the step is asked for again after the restart.
      if (this.codeMoved() !== null) {
        update(this.d.db, m.id, { busy: 0 }, this.now);
        return;
      }
      if (spec.slot && this.slotsUsed() >= this.d.config.agent.parallel) {
        update(this.d.db, m.id, { busy: 0 }, this.now);
        this.pollAt.set(m.id, this.now + 1);
        return;
      }
      // The step's budget minus the run time it already spent (a restart or a limit wait in between
      // never adds to it, LOOP-12).
      if (spec.timeoutMs !== undefined)
        spec = { ...spec, timeoutMs: Math.max(0, spec.timeoutMs - cur.step_secs * 1000) };
      let handle: ChildHandle;
      try {
        handle = this.d.tools.spawn(spec);
      } catch (e) {
        this.health.fail(`tool:${spec.argv[0]}`, (e as Error).message, this.now);
        this.move(cur, { event: "env_fail", why: (e as Error).message });
        return;
      }
      const r: Running = {
        handle,
        spec,
        startMono: this.d.clock.mono(),
        exit: null,
        termAt: null,
        timedOut: false,
      };
      this.children.set(m.id, r);
      void handle.done.then((exit) => {
        r.exit = exit;
      });
      update(
        this.d.db,
        m.id,
        {
          ...(p.launched ?? {}),
          busy: 1,
          child_pid: handle.pid,
          child_kind: spec.kind,
          child_since: this.now,
          child_model: spec.model ?? null,
          data: JSON.stringify({ ...dataOf(cur), launched: cur.step }),
        },
        this.now,
      );
    }
  }

  move(m: Mission, o: Outcome): Mission {
    this.pollAt.delete(m.id);
    if (o.event === "plan_merged" && this.slotTaken(m)) return this.markReady(m);
    const out = apply(this.applyCtx(), m, o);
    if (out.stage !== m.stage || out.id !== m.id) {
      this.lastPrPoll.delete(m.id);
      this.d.db.delMeta(`poll:${m.id}`);
    }
    return out;
  }

  /** LOOP-61: a plan-approved mission can't start building while the repo's slot is taken or others wait. */
  private slotTaken(m: Mission): boolean {
    if (phaseOf(m.stage, m.from_stage) !== "plan") return false;
    const ms = unfinished(this.d.db);
    const workers = this.d.config.repos.get(m.repo)?.workers ?? 1;
    if (buildingIn(ms, m.repo).length >= workers) return true;
    return ms.some((x) => x.id !== m.id && x.repo === m.repo && isReady(x));
  }

  /** Remember (once) that the plan is approved and the mission waits for the build slot. */
  private markReady(m: Mission): Mission {
    const cur = getMission(this.d.db, m.id) ?? m;
    const fresh = isReady(cur) ? cur : patchData(this.d.db, cur, { ready: this.now }, this.now);
    return update(this.d.db, fresh.id, { busy: 0 }, this.now);
  }

  /** LOOP-61: each repo with a free build slot starts its best ready mission. */
  private releaseReady(): void {
    for (const repo of this.d.config.repos.keys()) {
      const workers = this.d.config.repos.get(repo)?.workers ?? 1;
      for (;;) {
        const ms = unfinished(this.d.db);
        if (buildingIn(ms, repo).length >= workers) break;
        const m = bestReady(ms, repo, this.listing);
        if (!m) break;
        this.pollAt.delete(m.id);
        apply(this.applyCtx(), m, { event: "plan_merged", why: "the build slot is free" });
      }
    }
  }

  slotsUsed(): number {
    return [...this.children.values()].filter((r) => r.spec.slot && !r.exit).length;
  }

  /** Plan-approved missions waiting for their repo's build slot (LOOP-61). */
  queued(): Set<number> {
    return new Set(
      unfinished(this.d.db)
        .filter(isReady)
        .map((m) => m.id),
    );
  }

  cooldownUntil(model: string): number | null {
    const raw = this.d.db.meta(`cooldown:${model}`);
    if (!raw) return null;
    try {
      const until = (JSON.parse(raw) as { until: number }).until;
      return until > this.now ? until : null;
    } catch {
      return null;
    }
  }

  private cooling(m: Mission): boolean {
    return m.limit_model !== null && this.cooldownUntil(m.limit_model) !== null;
  }

  pickState(): PickState {
    const { db, config } = this.d;
    // Only repos with `ahead` intents ahead of build are full (LOOP-60).
    const ms = unfinished(db);
    const full = new Map<string, { n: number; ahead: number }>();
    for (const [name, repo] of config.repos) {
      const n = aheadIn(ms, name).length;
      if (n >= repo.ahead) full.set(name, { n, ahead: repo.ahead });
    }
    const started = new Set(
      db.all<{ key: string }>("SELECT key FROM meta WHERE key LIKE 'start:%'").map((r) => r.key.slice(6)),
    );
    const cooling = new Map<string, string>();
    for (const row of db.all<{ key: string }>("SELECT key FROM meta WHERE key LIKE 'cooldown:%'")) {
      const model = row.key.slice("cooldown:".length);
      const until = this.cooldownUntil(model);
      if (until) cooling.set(model, clockTime(until, this.now));
    }
    return {
      cutoff: config.intents.cutoff,
      paused: paused(db),
      blocked: this.health.blocked(this.now) ? (this.health.open()[0]?.kind ?? "problem") : null,
      repos: new Set(config.repos.keys()),
      full,
      started,
      cooling,
      active: new Set(unfinished(db).map((m) => m.intent)),
      defaultModel: config.agent.model,
    };
  }

  /** LOOP-5: insert a mission for the intent `decide` picks, when a slot is free. */
  private async pick(): Promise<string | null> {
    const listing = this.listing;
    if (!listing) return null;
    if (this.slotsUsed() >= this.d.config.agent.parallel) return null;
    let state = this.pickState();
    let l = listing;
    if (this.opts.intent) {
      if (this.targetId && this.d.db.get("SELECT 1 FROM missions WHERE intent = ?", this.targetId))
        return null;
      const target = await this.d.store.get(this.opts.intent).catch(() => null);
      if (!target) return null;
      this.targetId = target.id;
      l = { ...listing, open: listing.open.filter((i) => i.id === target.id) };
      state = { ...state, cutoff: 1 };
    }
    const decision = decide(l, state);
    for (const w of decision.writes) {
      try {
        await this.d.store.update(w.id, "wait", (e) => e.setField("waiting", w.waiting));
        const i = l.open.find((x) => x.id === w.id);
        this.d.db.run(
          "INSERT OR IGNORE INTO outbox (key, mission, text, created) VALUES (?, NULL, ?, ?)",
          `intent:${w.id}:${w.waiting}:${w.why}`,
          `${waitInfo(w.waiting).ask}\n${i?.title ?? w.id} (${i?.repo ?? "?"})\n${w.why}${i && this.d.store.url(i) ? `\n${this.d.store.url(i)}` : ""}`,
          this.now,
        );
      } catch (e) {
        this.d.log(`${w.id}: ${(e as Error).message}`);
      }
    }
    const pick = decision.pick;
    if (!pick) return null;
    const m = this.d.db.tx(() => {
      // LOOP-68: the repo may have been removed since this pass read the repos (another process).
      if (!this.d.db.get("SELECT 1 FROM repos WHERE name = ?", pick.repo)) return null;
      this.d.db.delMeta(`start:${pick.id}`);
      return insertMission(
        this.d.db,
        {
          intent: pick.id,
          slug: pick.slug,
          repo: pick.repo,
          model: pick.model ?? this.d.config.agent.model,
          a: pick.a,
        },
        this.now,
      );
    });
    if (!m) {
      this.d.log(`${pick.id}: its repo ${pick.repo} was just removed; not picked`);
      return null;
    }
    this.d.log(`picked ${pick.id} (${pick.repo}): ${pick.title}`);
    return m.intent;
  }

  private async selfUpdate(): Promise<void> {
    if (!this.d.selfUpdate || !this.d.config.update.auto) return;
    if (this.now - this.lastUpdate < UPDATE_POLL_S) return;
    this.lastUpdate = this.now;
    const r = await checkUpdate({
      tools: this.d.tools,
      checkout: checkoutRoot(),
      idle: () => this.children.size === 0 && this.featuresJob === null,
    });
    if (r.kind === "updated") {
      this.d.log(`updated ${r.from} → ${r.to}; restarting`);
      this.stop(RESTART_CODE);
    } else if (r.kind === "failed") {
      this.d.log(`self-update failed: ${r.why}`);
      this.d.db.run(
        "INSERT OR IGNORE INTO outbox (key, mission, text, created) VALUES (?, NULL, ?, ?)",
        `update:${r.why}`,
        `Towercab couldn't update itself and kept running the old version.\n${r.why}`,
        this.now,
      );
    }
  }

  private async sendMessages(): Promise<void> {
    const n = this.health.noticeDue(this.now);
    if (n) {
      this.d.db.run(
        "INSERT OR IGNORE INTO outbox (key, mission, text, created) VALUES (?, NULL, ?, ?)",
        `health:${n.kind}:${n.since}`,
        `Towercab can't reach ${n.kind} and has paused new work.\n${n.error}\n${fixFor(n.kind)}`,
        this.now,
      );
    }
    if (!this.d.sender) return;
    await sendDue(this.d.db, this.d.sender, this.now, (row) => this.obsolete(row));
  }

  /** A waiting message whose wait is over is dropped (LOOP-14). */
  private obsolete(row: { key: string; mission: number | null }): boolean {
    if (row.key.startsWith("proposed:")) {
      // LOOP-93: a proposal closed or merged before its message went is no longer worth one.
      return this.proposed !== null && !this.proposed.some((p) => `proposed:${p.number}` === row.key);
    }
    if (row.mission === null) return false;
    const m = getMission(this.d.db, row.mission);
    if (!m) return true;
    const [, wait, n] = row.key.split(":");
    return !m.waiting?.startsWith(wait ?? "") || String(m.continued) !== n;
  }

  /** For status and the UI. */
  state(): { listing: Listing | null; listingError: string | null } {
    return { listing: this.listing, listingError: this.listingError };
  }
}

/**
 * The mission as PR events should see it: a spec or plan PR whose merge the mission has already moved
 * past (its merge event would be ignored) is left out of the event order, so it can't mask the
 * owner's comments on it (an answer on the merged plan PR before a code PR exists).
 */
export function pastMerges(m: Mission, prs: { spec?: PrState; plan?: PrState }): Mission {
  const out = { ...m };
  if (prs.plan?.state === "MERGED" && next(m.stage, "plan_merged", m.from_stage).kind === "ignore")
    out.plan_pr = null;
  if (prs.spec?.state === "MERGED" && next(m.stage, "spec_merged", m.from_stage).kind === "ignore")
    out.spec_pr = null;
  return out;
}

/** `HH:MM` today, else `YYYY-MM-DD HH:MM`, local time. */
export function clockTime(unix: number, now: number): string {
  const d = new Date(unix * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = new Date(now * 1000).toDateString() === d.toDateString();
  return sameDay ? hm : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Read a run file as text, or "". */
export function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** An empty error file says nothing: remove it when its child ends (LOOP-40). */
function dropIfEmpty(path: string): void {
  try {
    if (statSync(path).size === 0) rmSync(path);
  } catch {
    // Already gone or never made.
  }
}
