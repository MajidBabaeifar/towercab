// The loop (LOOP-4..7, 11, 12, 17, 18): one pass every 5 s. Reads inputs, moves missions, starts
// work, sends messages. Single-threaded: children run detached and are reaped on the next pass.

import { readFileSync } from "node:fs";
import { Inhibitor, woke } from "./awake.ts";
import { removeCheckout } from "./checkout.ts";
import { applyPending, paused } from "./commands.ts";
import type { Config } from "./config.ts";
import type { Db, SqlValue } from "./db.ts";
import { Health } from "./faults.ts";
import { approveRequested, intentEvents, prEvents, releaseRequested } from "./github/events.ts";
import { type PrState, readPr } from "./github/prs.ts";
import { type ChildEnd, type Clock, type Ctx, EnvError, type GitHub, type Handlers } from "./handlers.ts";
import type { Home } from "./home.ts";
import type { Intent, IntentStore, Listing } from "./intents/types.ts";
import {
  type ApplyCtx,
  apply,
  finished,
  isWait,
  isWorking,
  type Outcome,
  phaseOf,
  type Subject,
} from "./machine.ts";
import { dataOf, getMission, insertMission, label, type Mission, unfinished, update } from "./mission.ts";
import { sendDue } from "./outbox.ts";
import { decide, orphans, type PickState } from "./pick.ts";
import { checkoutRoot } from "./service.ts";
import { type ChildHandle, KILL_AFTER_MS, killGroup, type Tools } from "./tools.ts";
import { checkUpdate, RESTART_CODE } from "./update.ts";

export const PASS_MS = 5_000;
const PR_POLL_S = 60;
const INTENTS_POLL_S = 60;
const UPDATE_POLL_S = 60;

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
  /** Self-update (LOOP-35); off in tests. */
  selfUpdate?: boolean;
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
  private lastPrPoll = new Map<number, number>();
  private lastUpdate = 0;
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
    await this.pollIntents(true);
  }

  /** Clean exit: children get SIGTERM, then SIGKILL; their missions are `interrupted`. */
  async shutdown(): Promise<void> {
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
      runs: (m) => d.home.runs(m.intent),
      record: (m, step, set = {}, data) =>
        d.db.tx(() => {
          const cols: Record<string, SqlValue> = { ...set, step };
          if (step !== m.step) {
            cols.unclean = 0;
            cols.retries = 0;
          }
          let fresh = update(d.db, m.id, cols, this.now);
          if (data)
            fresh = update(d.db, m.id, { data: JSON.stringify({ ...dataOf(fresh), ...data }) }, this.now);
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
      this.d.log("woke from suspend; polling everything before any timeout");
    }
    this.last = nowPoint;
    db.setMeta("last_pass", String(Math.floor(this.now)));
    db.setMeta("health", JSON.stringify(this.health.open()));

    // Commands from the CLI and the UI.
    for (const c of await applyPending({
      db,
      store: this.d.store,
      applyCtx: this.applyCtx(),
      now: new Date(this.now * 1000),
    })) {
      this.d.log(`command ${c.id}: ${c.result}`);
    }

    await this.reap();
    await this.enterDue();
    this.enforceTimeouts();
    await this.pollIntents(false);
    await this.pollPrs();
    await this.stepDue(!report.woke);
    if (!paused(db) && !this.health.blocked(this.now)) report.picked = await this.pick();
    await this.selfUpdate();
    await this.sendMessages();

    const driven = unfinished(db).find((m) => isWorking(m.stage) && !m.held && !this.cooling(m));
    this.inhibitor.update(driven ? `${driven.intent} ${driven.stage}` : null, clock.mono());

    const live = unfinished(db).filter((m) => isWorking(m.stage) && !this.cooling(m));
    report.idle = this.children.size === 0 && live.length === 0 && report.picked === null;
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
        {
          child_pid: null,
          child_kind: null,
          child_since: null,
          child_model: null,
          step_secs: m.step_secs + runMs / 1000,
        },
        this.now,
      );
      const end: ChildEnd = {
        ...r.exit,
        timedOut: r.timedOut,
        runMs,
        stdout: r.spec.stdout,
        stderr: r.spec.stderr,
      };
      const h = this.d.handlers[fresh.stage];
      if (!h) continue;
      await this.drive(fresh, () => h.finish(this.ctx(), fresh, end));
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
        const data = dataOf<{ dropped?: boolean }>(m);
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
            if (m.waiting && isWait(m.stage)) e.setField("waiting", m.waiting);
            else e.removeField("waiting");
            const spec = prUrl(m.spec_pr, repo?.github);
            const plan = prUrl(m.plan_pr, store.github());
            const code = prUrl(m.pr, repo?.github);
            if (spec) e.setField("spec_pr", spec);
            if (plan) e.setField("plan_pr", plan);
            if (code) e.setField("pr", code);
            if (m.stage === "pick") e.removeField("retry");
            if (m.stage === "done") {
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
    if (finished(m.stage)) removeCheckout(this.d.home.abs(m.checkout));
    const set: Record<string, SqlValue> = { step: "" };
    if (m.stage === "merge" && paused(db)) set.held = 1;
    update(db, m.id, set, this.now);
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
      this.health.ok("github");
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

  /** PR reads (LOOP-18, PIP-21): every 60 s per mission with a PR. */
  private async pollPrs(): Promise<void> {
    const read = this.d.readPr ?? ((repo: string, n: number) => readPr(this.d.github, repo, n));
    for (const m of unfinished(this.d.db)) {
      if (m.step === "enter" || (!m.spec_pr && !m.plan_pr && !m.pr)) continue;
      if (this.now - (this.lastPrPoll.get(m.id) ?? 0) < PR_POLL_S) continue;
      this.lastPrPoll.set(m.id, this.now);
      const repo = this.d.config.repos.get(m.repo);
      const intentsRepo = this.d.store.github();
      if (!repo) continue;
      try {
        const prs: { spec?: PrState; plan?: PrState; code?: PrState } = {};
        if (m.spec_pr) prs.spec = await read(repo.github, m.spec_pr);
        if (m.plan_pr && intentsRepo) prs.plan = await read(intentsRepo, m.plan_pr);
        if (m.pr) prs.code = await read(repo.github, m.pr);
        this.health.ok("github");
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
        const o = prEvents(m, prs, this.d.github.me, bot);
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
  private async drive(m: Mission, call: () => Promise<import("./handlers.ts").Progress>): Promise<void> {
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
      if (p.done.event !== "env_fail") this.health.ok("claude");
      this.move(cur, p.done);
    } else if ("poll" in p) {
      this.pollAt.set(m.id, this.now + p.poll);
      update(this.d.db, m.id, { busy: 0 }, this.now);
    } else {
      const spec = p.spawn;
      if (spec.slot && this.slotsUsed() >= this.d.config.agent.parallel) {
        update(this.d.db, m.id, { busy: 0 }, this.now);
        this.pollAt.set(m.id, this.now + 1);
        return;
      }
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
          busy: 1,
          child_pid: handle.pid,
          child_kind: spec.kind,
          child_since: this.now,
          child_model: spec.model ?? null,
        },
        this.now,
      );
    }
  }

  move(m: Mission, o: Outcome): Mission {
    this.pollAt.delete(m.id);
    const out = apply(this.applyCtx(), m, o);
    if (out.stage !== m.stage || out.id !== m.id) this.lastPrPoll.delete(m.id);
    return out;
  }

  slotsUsed(): number {
    return [...this.children.values()].filter((r) => r.spec.slot && !r.exit).length;
  }

  /** Missions past their repo's first `workers` unmerged ones (LOOP-4). */
  queued(): Set<number> {
    const out = new Set<number>();
    const perRepo = new Map<string, number>();
    for (const m of unfinished(this.d.db)) {
      if (m.merge_sha) continue;
      const n = (perRepo.get(m.repo) ?? 0) + 1;
      perRepo.set(m.repo, n);
      const workers = this.d.config.repos.get(m.repo)?.workers ?? 1;
      if (n > workers) out.add(m.id);
    }
    return out;
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
    const full = new Map<string, { n: number; workers: number }>();
    for (const m of unfinished(db)) {
      if (m.merge_sha) continue;
      const cur = full.get(m.repo) ?? { n: 0, workers: config.repos.get(m.repo)?.workers ?? 1 };
      cur.n++;
      full.set(m.repo, cur);
    }
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
          `The intent names a repo or dependency Towercab doesn't know.\n${i?.title ?? w.id} (${i?.repo ?? "?"})\n${w.why}${i && this.d.store.url(i) ? `\n${this.d.store.url(i)}` : ""}`,
          this.now,
        );
      } catch (e) {
        this.d.log(`${w.id}: ${(e as Error).message}`);
      }
    }
    const pick = decision.pick;
    if (!pick) return null;
    const m = this.d.db.tx(() =>
      insertMission(
        this.d.db,
        {
          intent: pick.id,
          slug: pick.slug,
          repo: pick.repo,
          model: pick.model ?? this.d.config.agent.model,
          a: pick.a,
        },
        this.now,
      ),
    );
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
      idle: () => this.children.size === 0,
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
        `Towercab can't reach ${n.kind} and has paused new work.\n${n.error}`,
        this.now,
      );
    }
    if (!this.d.sender) return;
    await sendDue(this.d.db, this.d.sender, this.now, (row) => this.obsolete(row));
  }

  /** A waiting message whose wait is over is dropped (LOOP-14). */
  private obsolete(row: { key: string; mission: number | null }): boolean {
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
