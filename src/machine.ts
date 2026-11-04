// The one state machine (LOOP-3, **Transitions**, **Waits**). Only `apply` moves a mission.
// A red line (REVIEW.md): a wrong move here merges, stops or loses work silently.

import type { Db, SqlValue } from "./db.ts";
import { COLUMNS, dataOf, getMission, insertMission, type Mission } from "./mission.ts";
import { type ShipFacts, shipFacts } from "./steps.ts";

export const ORDER = [
  "pick",
  "design",
  "plan",
  "build",
  "verify",
  "proof",
  "publish",
  "ci",
  "review",
  "gate",
  "merge",
  "steps",
  "deploy",
  "e2e",
  "done",
] as const;
/** SHIP-6: working stages outside the order. */
export const SHIP_EXTRA = ["rollback", "revert"] as const;
export const WAIT_STAGES = ["approval:spec", "approval:plan", "approval:merge", "blocked"] as const;

export type WorkStage = (typeof ORDER)[number] | (typeof SHIP_EXTRA)[number];
export type WaitStage = (typeof WAIT_STAGES)[number];
export type Stage = WorkStage | WaitStage | "stopped" | "unverified";

export const STAGES: Stage[] = [...ORDER, ...SHIP_EXTRA, ...WAIT_STAGES, "stopped", "unverified"];

export const EVENTS = [
  "ok",
  "red",
  "timeout",
  "bad_result",
  "interrupted",
  "limit",
  "wait",
  "env_fail",
  "crash",
  "spec_merged",
  "plan_merged",
  "code_merged",
  "closed",
  "feedback",
  "answered",
  "conflict",
  "head_moved",
  "intent_removed",
  "retry_fresh",
  "recheck",
  "resume",
  "skip",
  "revert",
] as const;
export type Event = (typeof EVENTS)[number];

export type Next =
  | { kind: "go"; to: Stage }
  | { kind: "wait" }
  | { kind: "again" }
  | { kind: "cool" }
  | { kind: "backoff" }
  | { kind: "recover" }
  | { kind: "stop" }
  | { kind: "continue" }
  | { kind: "fresh" }
  | { kind: "ignore" }
  | { kind: "unexpected" };

const go = (to: Stage): Next => ({ kind: "go", to });
const K = (kind: Exclude<Next["kind"], "go">): Next => ({ kind }) as Next;

export function isWait(s: Stage): s is WaitStage {
  return (WAIT_STAGES as readonly string[]).includes(s);
}

export function isWorking(s: Stage): boolean {
  return ((ORDER as readonly string[]).includes(s) && s !== "done") || isShipExtra(s);
}

function isShipExtra(s: Stage): boolean {
  return (SHIP_EXTRA as readonly string[]).includes(s);
}

/** LOOP-73: `unverified` ends a change that merged but can't be checked live; it is final like `done`. */
export function finished(s: Stage): boolean {
  return s === "done" || s === "stopped" || s === "unverified";
}

/** Position in ORDER (waits and stopped: -1). */
export function orderIndex(s: Stage): number {
  return (ORDER as readonly string[]).indexOf(s);
}

const between = (s: Stage, a: WorkStage, b: WorkStage) =>
  orderIndex(s) >= orderIndex(a) && orderIndex(s) <= orderIndex(b);

/**
 * The transition table. `from` is the stage a wait was entered from (blocked uses it for
 * `spec_merged`/`plan_merged`).
 */
export function next(
  stage: Stage,
  event: Event,
  from: Stage | null = null,
  facts: ShipFacts = { steps: false, nothingLive: false },
): Next {
  if (finished(stage)) return K("ignore");
  const wait = isWait(stage);
  switch (event) {
    case "ok":
      if (wait || stage === "revert") return K("unexpected");
      if (stage === "rollback") return go("build");
      return go(ORDER[orderIndex(stage) + 1]!);
    case "red":
      // PIP-98: a review that doesn't approve is a fix round too.
      if (stage === "verify" || stage === "proof" || stage === "ci" || stage === "review") return go("build");
      if (stage === "deploy" || stage === "e2e") return go("rollback");
      return K("unexpected");
    case "skip":
      if (stage !== "deploy") return K("unexpected");
      // SHIP-21: no live check ends as unverified, unless the plan says there is nothing to check.
      return go(facts.nothingLive ? "done" : "unverified");
    case "revert":
      return stage === "rollback" ? go("revert") : K("unexpected");
    case "timeout":
    case "bad_result":
    case "interrupted":
      return wait ? K("ignore") : K("again");
    case "limit":
      return wait ? K("unexpected") : K("cool");
    case "wait":
      return K("wait");
    case "env_fail":
      return K("backoff");
    case "crash":
      return wait ? K("ignore") : K("recover");
    case "spec_merged":
      if (stage === "design" || stage === "approval:spec") return go("plan");
      if (stage === "blocked" && from === "design") return go("plan");
      return K("ignore");
    case "plan_merged":
      if (stage === "plan" || stage === "approval:plan") return go("build");
      if (stage === "blocked" && from === "plan") return go("build");
      return K("ignore");
    case "code_merged":
      // A wait after shipping (a frozen repo, a revert) keeps reading its merged PR: no new ship.
      if (stage === "blocked" && from && (orderIndex(from) > orderIndex("merge") || isShipExtra(from)))
        return K("ignore");
      if (stage === "approval:merge" || stage === "blocked") return go(facts.steps ? "steps" : "deploy");
      if (between(stage, "build", "merge")) return go(facts.steps ? "steps" : "deploy");
      return K("ignore");
    case "closed":
    case "intent_removed":
      return K("stop");
    case "feedback":
      if (stage === "approval:spec") return go("design");
      if (stage === "approval:plan") return go("plan");
      if (stage === "approval:merge") return go("build");
      if (stage === "blocked") return K("continue");
      if (between(stage, "verify", "merge")) return go("build");
      return K("ignore");
    case "answered":
      return stage === "blocked" ? K("continue") : K("ignore");
    case "conflict":
      if (stage === "approval:merge" || stage === "blocked") return go("build");
      if (between(stage, "ci", "merge")) return go("build");
      return K("ignore");
    case "head_moved":
      if (stage === "approval:merge") return go("ci");
      if (between(stage, "review", "merge")) return go("ci");
      return K("ignore");
    case "retry_fresh":
      return K("fresh");
    // AUT-21: the owner's retry of a gate's risk check that didn't finish.
    case "recheck":
      if (stage === "approval:spec") return go("design");
      if (stage === "approval:plan") return go("plan");
      if (stage === "approval:merge") return go("review");
      return K("ignore");
    case "resume":
      return stage === "merge" ? K("again") : K("ignore");
  }
}

/**
 * **Waits**: the `waiting:` text's key → its stage and the ask (message line 1, the UI's card). The
 * keys are stored in intent files and never change; the asks say plainly what the owner decides or
 * does (PIP-110).
 */
export const WAITS: Record<string, { stage: Stage; ask: string }> = {
  "approve spec": {
    stage: "approval:spec",
    ask: "Decide if this is the right change to build: merge the spec PR to go ahead, or comment what to change.",
  },
  "approve plan": {
    stage: "approval:plan",
    ask: "Decide if it should be built this way, with the access it asks for: merge the plan PR to start, or comment what to change.",
  },
  "review and merge PR": {
    stage: "approval:merge",
    ask: "Decide if this change can go live: merge the PR to ship it, or comment what to fix.",
  },
  "answer the question": {
    stage: "blocked",
    ask: "Answer a question so the work can go on: pick an option or write your own.",
  },
  "checks red": {
    stage: "blocked",
    ask: "The tests can't pass without your help. Reply with what to change, or start over.",
  },
  "allow check writes": {
    stage: "blocked",
    ask: "Decide if the tests may write to this machine's shared build cache: reply allow or no.",
  },
  "tests don't prove the change": {
    stage: "blocked",
    ask: "No test shows the change works. Reply with what a test should check, or say go on to continue without one.",
  },
  "CI red": {
    stage: "blocked",
    ask: "GitHub's checks still fail after two fix attempts. Reply with a hint on what to change, or start over.",
  },
  "CI stuck": {
    stage: "blocked",
    ask: "GitHub's checks didn't finish in time. Make sure they run, then reply so Towercab looks again.",
  },
  "worker timeout": {
    stage: "blocked",
    ask: "The agent ran out of time before finishing. Reply to let it carry on, or start over.",
  },
  "worker budget": {
    stage: "blocked",
    ask: "The agent used up its budget before finishing. Reply to let it carry on, or start over.",
  },
  "no result": {
    stage: "blocked",
    ask: "The agent stopped without a usable answer. Reply to let it carry on, or start over.",
  },
  "no changes": {
    stage: "blocked",
    ask: "The agent finished without changing anything. Reply with what it should do, or drop the intent if nothing is needed.",
  },
  "crashed at": {
    stage: "blocked",
    ask: "Towercab failed three times at the same step. Reply to try again once the cause is fixed, or start over.",
  },
  "spec conflict": {
    stage: "blocked",
    ask: "The spec clashes with other changes and Towercab couldn't combine them. Resolve it in the spec PR, then reply.",
  },
  "merge failed": {
    stage: "blocked",
    ask: "GitHub refused to merge the change. Fix what GitHub objects to, then reply to try again.",
  },
  "add CLAUDE.md verifying block": {
    stage: "blocked",
    ask: "Towercab doesn't know how to test this repo yet. Add a verifying section to its CLAUDE.md, then reply.",
  },
  "fix repo files": {
    stage: "blocked",
    ask: "One of the repo's files for Towercab can't be read. Fix it, then reply.",
  },
  "unknown repo": {
    stage: "blocked",
    ask: "Tell Towercab which repo this is for: add the repo, or fix the repo name in the intent.",
  },
  "bad after:": {
    stage: "blocked",
    ask: "Fix what this intent waits for: Towercab can't find one of the intents it names, or it was dropped.",
  },
  "rolled back, revise": {
    stage: "blocked",
    ask: "The change broke the live app, two fixes didn't hold, and it was taken back out. Revise the intent, then start over (/retry).",
  },
  "rollback failed": {
    stage: "blocked",
    ask: "Taking the broken change back out failed, so nothing more goes live in this repo until you fix it.",
  },
  // LOOP-74: the checklist is in the why. The first holds the gate; the second is the `steps` stage itself.
  "your steps first": {
    stage: "blocked",
    ask: "Do these before this change merges: tick them off in Towercab, or reply to change the plan.",
  },
  "your steps": {
    stage: "steps",
    ask: "Do these so the change works live: tick them off in Towercab.",
  },
};

/** The WAITS key of a `waiting:` text (`crashed at build` → `crashed at`). */
export function waitKey(waiting: string): string {
  if (waiting.startsWith("crashed at")) return "crashed at";
  if (waiting.startsWith("bad after:")) return "bad after:";
  return waiting;
}

export function waitInfo(waiting: string): { stage: Stage; ask: string } {
  const w = WAITS[waitKey(waiting)];
  if (!w) throw new Error(`bug: unknown wait "${waiting}"`);
  return w;
}

/** Where a blocked mission goes on `continue` (an answer, feedback, `waiting` removed). */
export function continueTo(waiting: string | null, from: Stage | null): Stage {
  if (waiting?.startsWith("crashed at ")) {
    const s = waiting.slice("crashed at ".length) as Stage;
    if (STAGES.includes(s)) return s;
  }
  if (waiting === "CI stuck") return "ci";
  if (waiting === "merge failed" || waiting === "your steps first") return "gate";
  // PIP-95: the answer is read where the question was asked.
  if (waiting === "allow check writes" && from) return from;
  if (from === "pick" || from === "design" || from === "plan") return from;
  return "build";
}

/** The intent's `stage` field (INT-5): the phase a person cares about. */
export function phaseOf(stage: Stage, from: Stage | null): "spec" | "plan" | "code" | "done" | "dropped" {
  const s = stage === "blocked" && from ? from : stage;
  if (s === "done" || s === "unverified") return "done";
  if (s === "stopped") return "dropped";
  if (s === "pick" || s === "design" || s === "approval:spec") return "spec";
  if (s === "plan" || s === "approval:plan") return "plan";
  return "code";
}

/** What a handler (or an event source) reports. */
export interface Outcome {
  event: Event;
  /** For `wait`: the `waiting:` text. */
  waiting?: string;
  why?: string;
  /** For `limit`: the cooling model and until when (unix s). */
  limit?: { model: string; until: number; backoffs: number; text: string };
  /** For `answered`/`feedback`: the owner's text, kept for the next worker prompt. */
  text?: string;
  /** Mission columns to set in the same transaction. */
  set?: Record<string, SqlValue>;
  /** Keys to merge into `missions.data` in the same transaction. */
  data?: Record<string, unknown>;
  /** `meta` rows to write in the same transaction (SHIP-9's last good version). */
  meta?: Record<string, string>;
}

export const ok = (o: Partial<Outcome> = {}): Outcome => ({ event: "ok", ...o });
export const red = (why: string, o: Partial<Outcome> = {}): Outcome => ({ event: "red", why, ...o });
export const wait = (waiting: string, why?: string, o: Partial<Outcome> = {}): Outcome => ({
  event: "wait",
  waiting,
  why,
  ...o,
});

/** Who/what a message is about (title and link come from the intent). */
export interface Subject {
  title: string;
  repo: string;
  link: string | null;
}

export interface ApplyCtx {
  db: Db;
  now: number;
  subject: (m: Mission) => Subject;
  /** LOOP-10's backoff after `retries` failures, seconds. */
  backoff?: (retries: number) => number;
  log?: (line: string) => void;
}

export const CRASH_LIMIT = 3;

export function envBackoff(retries: number): number {
  return [30, 60, 120, 240, 300][Math.min(retries, 4)]!;
}

/** The text of a wait's message (LOOP-14): the ask, title and repo, why, link. */
export function waitMessage(waiting: string, s: Subject, why: string | null): string {
  const lines = [waitInfo(waiting).ask, `${s.title} (${s.repo})`];
  if (why) lines.push(oneLine(why, 300));
  if (s.link) lines.push(s.link);
  return lines.join("\n").slice(0, 4000);
}

export function oneLine(s: string, max: number): string {
  const l = s.replace(/\s+/g, " ").trim();
  return l.length > max ? `${l.slice(0, max - 1)}…` : l;
}

/**
 * Move a mission (LOOP-6): one transaction writes its new stage, `step = 'enter'`, the outcome's
 * columns, a `transitions` row and, for a wait, its outbox row. Returns the fresh row (for `fresh`,
 * the new attempt's). A mission no longer at `m.stage` is left alone.
 */
export function apply(cx: ApplyCtx, m: Mission, o: Outcome): Mission {
  const { db, now } = cx;
  return db.tx(() => {
    const cur = getMission(db, m.id);
    if (!cur || cur.stage !== m.stage) return cur ?? m;
    let data = dataOf(cur);
    if (o.data) data = { ...data, ...o.data };
    let n = next(cur.stage, o.event, cur.from_stage, shipFacts(data));
    if (n.kind === "unexpected") {
      cx.log?.(`unexpected ${o.event} at ${cur.stage}`);
      n = isWait(cur.stage) ? { kind: "ignore" } : { kind: "recover" };
    }
    const set: Record<string, SqlValue> = { ...(o.set ?? {}) };
    for (const c of Object.keys(set)) if (!COLUMNS.has(c)) throw new Error(`bug: column ${c} can't be set`);

    const move = (to: Stage, extra: Record<string, SqlValue>, why: string | null) => {
      const leavingWait = isWait(cur.stage) && to !== cur.stage;
      const cols: Record<string, SqlValue> = {
        ...set,
        stage: to,
        step: "enter",
        busy: 0,
        retries: 0,
        retry_at: null,
        limit_model: null,
        why,
        ...extra,
      };
      if (to !== cur.stage) cols.step_secs = 0;
      if (leavingWait) cols.continued = cur.continued + 1;
      // `your steps` is a wait at a working stage (LOOP-74): it keeps its text.
      if (!isWait(to) && !(to === "steps" && extra.waiting)) {
        cols.waiting = null;
        cols.from_stage = null;
      }
      if (finished(to)) cols.finished = now;
      // The new stage's steps haven't launched anything (LOOP-4).
      data = { ...data, launched: undefined, ...(leavingWait ? { doneByYou: undefined } : {}) };
      write(cols);
      db.run(
        "INSERT INTO transitions (mission, at, from_stage, event, to_stage, why) VALUES (?, ?, ?, ?, ?, ?)",
        cur.id,
        now,
        cur.stage,
        o.event,
        to,
        why,
      );
      cx.log?.(`${cur.intent} ${cur.stage} → ${to} (${o.event}${why ? `: ${oneLine(why, 120)}` : ""})`);
    };
    const write = (cols: Record<string, SqlValue>) => {
      cols.data = JSON.stringify(data);
      const keys = Object.keys(cols);
      db.run(
        `UPDATE missions SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated = ? WHERE id = ?`,
        ...keys.map((k) => cols[k]!),
        now,
        cur.id,
      );
    };
    const toWait = (waiting: string, why: string | null) => {
      const info = waitInfo(waiting);
      // PIP-107: a wait that asks no question of its own drops an earlier one and its brief, so a card
      // never shows a question that was already answered.
      if (!o.data?.question) data = { ...data, question: undefined, brief: undefined };
      const fromStage = isWait(cur.stage) ? cur.from_stage : cur.stage;
      // A new wait from inside a wait still counts as a new message.
      const continued = isWait(cur.stage) ? cur.continued + 1 : cur.continued;
      move(info.stage, { waiting, from_stage: fromStage, continued }, why);
      const key = `${cur.id}:${waitKey(waiting)}:${continued}`;
      db.run(
        "INSERT OR IGNORE INTO outbox (key, mission, text, created) VALUES (?, ?, ?, ?)",
        key,
        cur.id,
        waitMessage(waiting, cx.subject(cur), why),
        now,
      );
    };

    if (o.meta && n.kind === "go") for (const [k, v] of Object.entries(o.meta)) db.setMeta(k, v);
    switch (n.kind) {
      case "go":
        if (o.text) data.answer = o.text;
        move(n.to, {}, o.why ?? null);
        break;
      case "wait":
        if (!o.waiting) throw new Error("bug: wait without a waiting text");
        toWait(o.waiting, o.why ?? null);
        break;
      case "again":
        write({ ...set, step: cur.step === "enter" ? "enter" : cur.step, busy: 0 });
        break;
      case "cool": {
        if (!o.limit) throw new Error("bug: limit without a limit");
        const { model, until, backoffs, text } = o.limit;
        db.run(
          "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          `cooldown:${model}`,
          JSON.stringify({ until, backoffs, text, since: now }),
        );
        write({ ...set, limit_model: model, busy: 0 });
        break;
      }
      case "backoff": {
        const retries = cur.retries + 1;
        const after = (cx.backoff ?? envBackoff)(cur.retries);
        write({ ...set, retries, retry_at: now + after, busy: 0, why: o.why ?? cur.why });
        break;
      }
      case "recover": {
        const unclean = cur.unclean + 1;
        if (unclean >= CRASH_LIMIT) {
          set.unclean = 0;
          toWait(`crashed at ${cur.stage}`, o.why ?? null);
        } else {
          write({ ...set, unclean, busy: 0 });
        }
        break;
      }
      case "stop": {
        if (o.event === "closed") data.dropped = true;
        move("stopped", {}, o.why ?? (o.event === "closed" ? "PR closed" : "intent removed"));
        break;
      }
      case "continue": {
        const to = continueTo(cur.waiting, cur.from_stage);
        if (o.text) data.answer = o.text;
        move(to, { repairs: 0, ci_repairs: 0, unclean: 0 }, o.why ?? null);
        break;
      }
      case "fresh": {
        move("stopped", {}, `replaced by attempt ${cur.attempt + 1}`);
        const slug = slugOf(cur);
        return insertMission(
          db,
          {
            intent: cur.intent,
            slug,
            repo: cur.repo,
            model: cur.model,
            a: cur.a_at_pick,
            minAttempt: cur.attempt + 1,
          },
          now,
        );
      }
      case "ignore":
        break;
    }
    return getMission(db, cur.id)!;
  });
}

/** The slug part of `towercab/<id>-<slug>[-<attempt>]`. */
export function slugOf(m: Mission): string {
  let s = m.branch.replace(/^towercab\//, "");
  if (s.startsWith(`${m.intent}-`)) s = s.slice(m.intent.length + 1);
  if (m.attempt >= 2 && s.endsWith(`-${m.attempt}`)) s = s.slice(0, -`-${m.attempt}`.length);
  return s;
}
