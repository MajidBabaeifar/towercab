// The shadow (SHD-1..20, LOOP-129, LOOP-130): the owner's Telegram messages in, one long-lived Claude
// session with no tools, Towercab's own actions out. `pass()` is called by the loop each pass; a turn
// runs as a detached child that later passes reap, so a slow answer never delays the loop's polling.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentBudgetUsd, loadAgent } from "../agents.ts";
import { type ClaudeRun, parseRun, prepareRun, runEndLine } from "../claude.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import type { Clock } from "../handlers.ts";
import type { Home } from "../home.ts";
import { parseResult, SCHEMAS, type ShadowResult } from "../pipeline/schemas.ts";
import { checkoutRoot } from "../service.ts";
import type { TelegramUpdate } from "../telegram.ts";
import type { ChildHandle, Tools } from "../tools.ts";
import type { Executor } from "./actions.ts";
import {
  isNo,
  isYes,
  KEEP_TURNS,
  namedAnswer,
  resultsText,
  SUMMARY_MAX,
  seedText,
  summaryPrompt,
  tooLong,
  turnPrompt,
} from "./prompt.ts";
import {
  actionsOfTurn,
  addCost,
  addOwnerTurn,
  CAPPED,
  costToday,
  dayStart,
  epoch,
  finishTurn,
  getTurn,
  liveTurns,
  nextTurn,
  OFFSET,
  offset,
  pendingActions,
  prune,
  resetShadow,
  SESSION,
  STARTED,
  SUMMARY,
  setTurnState,
  statusText,
  type Turn,
  tell,
} from "./store.ts";

/** LOOP-130: a turn running longer than this is stopped. */
export const TURN_LIMIT_MS = 10 * 60_000;
/** SHD-5: read rounds per turn. */
export const MAX_ROUNDS = 3;
/** One read's text is cut to this. */
export const READ_MAX = 6_000;

export interface ShadowDeps {
  config: Config;
  home: Home;
  db: Db;
  tools: Tools;
  clock: Clock;
  log(line: string): void;
  /** The Bot API's `getUpdates`; null: no Telegram. */
  telegram: { updates(offset: number): Promise<TelegramUpdate[]> } | null;
  /** SHD-4: Towercab's state in words, read fresh for each run. */
  snapshot(): Promise<string>;
  /** SHD-5: one read (`intent`, `queue`, `activity`, `repos`, `pr`, `runfile`). */
  read(kind: string, ref: string): Promise<string>;
  exec: Executor;
  /** The user's HOME for the sandbox settings (default the real one). */
  userHome?: string;
  towercabExe?: string;
}

interface Step {
  /** `turn`, or `summary` (SHD-16). */
  kind: "turn" | "summary";
  round: number;
  results: { kind: string; ref: string; text: string }[];
  /** The session was gone once already. */
  retried: boolean;
}

interface Running {
  handle: ChildHandle;
  turn: number;
  step: Step;
  stdout: string;
  stderr: string;
  startMono: number;
  epoch: number;
  exit: { code: number | null; signal: string | null } | null;
  timedOut: boolean;
  /** Stopped by `stop()`: the turn stays pending. */
  stopped: boolean;
}

const read = (p: string): string => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};

const BOT_SUFFIX = /@\w+$/;

export class Shadow {
  private d: ShadowDeps;
  private running: Running | null = null;

  constructor(d: ShadowDeps) {
    this.d = d;
  }

  /** SHD-1: the shadow runs only when `[shadow] enabled` and Telegram is set. */
  get on(): boolean {
    return this.d.config.shadow.enabled && this.d.telegram !== null && this.d.config.telegram !== null;
  }

  /** A turn is running: the loop is not idle and does not restart or update (LOOP-130). */
  busy(): boolean {
    return this.running !== null;
  }

  /** Shutdown: a running turn's child is stopped; its message stays pending and runs again at the next start. */
  async stop(): Promise<void> {
    const r = this.running;
    if (!r) return;
    r.stopped = true;
    r.handle.kill("SIGTERM");
    await r.handle.done.catch(() => undefined);
    this.running = null;
  }

  /** One pass: read the chat, reap a finished turn, start the next message. Never throws. */
  async pass(): Promise<void> {
    if (!this.on) return;
    try {
      await this.poll();
      await this.watch();
      if (!this.running) {
        const { db, clock } = this.d;
        for (const line of this.d.exec.expire())
          tell(db, `shadow:expire:${clock.now()}:${line.length}`, `[shadow] ${line}`, clock.now());
        prune(db, clock.now());
        await this.next();
      }
    } catch (e) {
      this.d.log(`shadow: ${(e as Error).message}`);
    }
  }

  /** LOOP-129, SHD-2, SHD-20: owner messages become stored turns; the offset moves with them. */
  private async poll(): Promise<void> {
    const { db, clock, config } = this.d;
    let ups: TelegramUpdate[];
    try {
      ups = await this.d.telegram!.updates(offset(db));
    } catch {
      return; // Telegram logged it once per outage; the next pass tries again.
    }
    if (!ups.length) return;
    db.tx(() => {
      let top = offset(db);
      for (const u of ups) {
        top = Math.max(top, u.id + 1);
        const text = u.text?.trim();
        if (u.chat === config.telegram!.chatId && text) addOwnerTurn(db, u.id, text, clock.now());
      }
      db.setMeta(OFFSET, String(top));
    });
  }

  /** LOOP-130: stop a turn past its limit, and handle one that ended. */
  private async watch(): Promise<void> {
    const r = this.running;
    if (!r) return;
    if (!r.exit && this.d.clock.mono() - r.startMono > TURN_LIMIT_MS) {
      r.timedOut = true;
      r.handle.kill("SIGKILL");
      await r.handle.done.catch(() => undefined);
    }
    if (!r.exit) return;
    this.running = null;
    await this.ended(r);
  }

  private async next(): Promise<void> {
    const { db, clock, config } = this.d;
    const t = nextTurn(db);
    if (!t) return;
    const now = clock.now();
    const word = t.text.trim().replace(BOT_SUFFIX, "").toLowerCase();
    // LOOP-131: the owner's commands, matched by code on the chat text.
    if (word === "/reset") {
      resetShadow(db);
      tell(
        db,
        `shadow:reset:${t.update_id}`,
        "[shadow] Done: I've forgotten our conversation. My action log is kept.",
        now,
      );
      return;
    }
    if (word === "/status") {
      finishTurn(db, t.id, t.update_id, `[shadow] ${statusText(db, config.shadow, now)}`, now);
      return;
    }
    // SHD-20: a turn that already acted (a yes taken off the waiting list, a run that started) is closed
    // with what happened, never run or answered again.
    const done = this.d.exec.recover(t.id);
    if (done !== null) {
      finishTurn(db, t.id, t.update_id, `[shadow] ${done}`, now);
      return;
    }
    const named = namedAnswer(t.text);
    if ((named || isYes(t.text) || isNo(t.text)) && pendingActions(db).length) {
      const yes = named ? named.yes : isYes(t.text);
      const line = await this.d.exec.answer(yes, {
        turn: t.id,
        ...(named ? { target: { action: named.action, intent: named.intent } } : {}),
      });
      finishTurn(db, t.id, t.update_id, `[shadow] ${line}`, now);
      return;
    }
    // SHD-18: the shadow's own daily cap.
    if (costToday(db, now) >= config.shadow.dailyBudgetUsd) {
      const day = String(dayStart(now));
      if (db.meta(CAPPED) !== day) {
        db.setMeta(CAPPED, day);
        finishTurn(
          db,
          t.id,
          t.update_id,
          `[shadow] I've reached today's cap ($${config.shadow.dailyBudgetUsd.toFixed(2)}), so I'm stopping until midnight. You can raise it with [shadow] daily_budget_usd.`,
          now,
          "skipped",
        );
      } else {
        setTurnState(db, t.id, "skipped");
      }
      return;
    }
    await this.launch(t, { kind: "turn", round: 0, results: [], retried: false });
  }

  /** Start a run for turn `t`: its prompt, its sandboxed child; the session is new or resumed (SHD-1). */
  private async launch(t: Turn, step: Step, prompt?: string): Promise<void> {
    const { db, clock, config, home } = this.d;
    const agent = loadAgent("shadow");
    const summarizing = step.kind === "summary";
    let session: ClaudeRun["session"] = { mode: "none", id: "" };
    let text = prompt ?? "";
    if (!summarizing) {
      const have = db.meta(SESSION);
      const id = have ?? randomUUID();
      const others = liveTurns(db).filter((x) => x.id < t.id);
      text = turnPrompt({
        earlier: have ? "" : seedText(db.meta(SUMMARY), others),
        state: await this.d.snapshot(),
        results: resultsText(step.results),
        message: t.text,
      });
      if (!have) {
        db.setMeta(SESSION, id);
        db.setMeta(STARTED, String(clock.now()));
      }
      session = have ? { mode: "resume", id } : { mode: "new", id };
    }
    const n = Number(db.meta("shadow.n") ?? 0) + 1;
    db.setMeta("shadow.n", String(n));
    const runsDir = home.runs("shadow");
    const cwd = join(runsDir, "empty");
    mkdirSync(cwd, { recursive: true });
    const run: ClaudeRun = {
      kind: "shadow",
      model: config.shadow.model ?? config.agent.model,
      cwd,
      runsDir,
      n,
      prompt: text,
      agent: "shadow",
      schema: SCHEMAS.shadow,
      session,
      budgetUsd: agentBudgetUsd(agent, config),
      claudeMd: "",
      grants: { domains: [], paths: [], open: false },
      cacheEnv: {},
      config,
    };
    const spec = {
      ...prepareRun(run, {
        towercabExe: this.d.towercabExe ?? join(checkoutRoot(), "bin", "towercab"),
        home: this.d.userHome ?? homedir(),
      }),
      slot: false,
    };
    let handle: ChildHandle;
    try {
      handle = this.d.tools.spawn(spec);
    } catch (e) {
      finishTurn(
        db,
        t.id,
        t.update_id,
        `[shadow] I couldn't start: ${(e as Error).message}`,
        clock.now(),
        "failed",
      );
      return;
    }
    const r: Running = {
      handle,
      turn: t.id,
      step,
      stdout: spec.stdout,
      stderr: spec.stderr,
      startMono: clock.mono(),
      epoch: epoch(db),
      exit: null,
      timedOut: false,
      stopped: false,
    };
    this.running = r;
    void handle.done.then((exit) => {
      r.exit = exit;
    });
  }

  /** A run ended: its answer, a read round, the actions, or the reason it failed. */
  private async ended(r: Running): Promise<void> {
    const { db, clock, config } = this.d;
    if (r.stopped) return;
    const t = getTurn(db, r.turn);
    // SHD-17: the conversation was reset while this ran; nothing of it is kept.
    if (!t || epoch(db) !== r.epoch) return;
    const say = (text: string, state: Turn["state"] = "done") =>
      finishTurn(db, t.id, t.update_id, `[shadow] ${text}`, clock.now(), state);
    if (r.timedOut) {
      if (r.step.kind === "turn")
        say(
          "That took more than 10 minutes, so I stopped it. Ask me again, maybe in smaller pieces.",
          "failed",
        );
      return;
    }
    const end = parseRun(read(r.stdout), read(r.stderr), r.exit!.code, {
      model: config.shadow.model ?? config.agent.model,
      now: new Date(clock.now() * 1000),
      home: this.d.userHome ?? homedir(),
    });
    const used = "result" in end ? end.result : null;
    if (used) addCost(db, t.id, used.costUsd);
    if (r.step.kind === "summary") {
      this.folded(end);
      return;
    }
    if (end.kind === "sessionGone") {
      db.delMeta(SESSION);
      if (r.step.retried) return say("My session kept getting lost. Try again in a minute.", "failed");
      return this.launch(t, { ...r.step, retried: true });
    }
    if (end.kind !== "ok") {
      return say(`I couldn't answer (${runEndLine(end)}). Ask me again in a while.`, "failed");
    }
    const parsed = parseResult("shadow", end.result.structuredOutput);
    if (!parsed.ok) return say(`I couldn't answer (${parsed.why}). Ask me again.`, "failed");
    const out: ShadowResult = parsed.value;
    const capped = costToday(db, clock.now()) >= config.shadow.dailyBudgetUsd;
    if (out.reads.length && r.step.round < MAX_ROUNDS && !capped) {
      const results = [...r.step.results];
      for (const rd of out.reads.slice(0, 3)) {
        let text: string;
        try {
          text = await this.d.read(rd.kind, rd.ref);
        } catch (e) {
          text = `could not read: ${(e as Error).message}`;
        }
        results.push({
          kind: rd.kind,
          ref: rd.ref,
          text: text.length > READ_MAX ? `${text.slice(0, READ_MAX)}…` : text,
        });
      }
      return this.launch(t, {
        kind: "turn",
        round: r.step.round + 1,
        results: results.slice(-9),
        retried: false,
      });
    }
    const lines: string[] = [];
    for (const [i, a] of out.actions.entries()) lines.push(await this.d.exec.request(t.id, i, a));
    const reply = out.reply.trim();
    say([reply, ...lines].filter(Boolean).join("\n\n") || "Done.");
    this.maybeFold(t);
  }

  /** SHD-16: a long conversation is folded into a summary by one more run. */
  private maybeFold(t: Turn): void {
    const { db } = this.d;
    const turns = liveTurns(db);
    if (!tooLong(turns) || this.running) return;
    const old = turns.slice(0, Math.max(0, turns.length - KEEP_TURNS));
    if (!old.length) return;
    const prompt = summaryPrompt(db.meta(SUMMARY), old, pendingActions(db));
    db.setMeta("shadow.fold", String(old[old.length - 1]!.id));
    void this.launch(t, { kind: "summary", round: 0, results: [], retried: false }, prompt);
  }

  private folded(end: ReturnType<typeof parseRun>): void {
    const { db } = this.d;
    const upTo = Number(db.meta("shadow.fold") ?? 0);
    db.delMeta("shadow.fold");
    if (end.kind !== "ok") return;
    const parsed = parseResult("shadow", end.result.structuredOutput);
    const summary = parsed.ok ? parsed.value.reply.trim().slice(0, SUMMARY_MAX) : "";
    if (!summary || !upTo) return;
    db.tx(() => {
      db.setMeta(SUMMARY, summary);
      db.run("UPDATE shadow_turns SET folded = 1 WHERE id <= ?", upTo);
      // The next message starts a session seeded with the summary and the last turns.
      db.delMeta(SESSION);
    });
  }

  /** What the owner did with this turn's actions, for tests and `status`. */
  actionsOf(turn: number) {
    return actionsOfTurn(this.d.db, turn);
  }
}
