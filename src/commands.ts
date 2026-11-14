// Commands (LOOP-15): answer, retry, drop, pause, resume, start. The CLI and the UI insert a `commands` row;
// the loop applies it on its next pass, or the CLI applies it itself when no loop runs.

import { ownerOnly, ownerOnlyLine } from "./autonomy.ts";
import { levelNow } from "./autonomy-change.ts";
import type { Db } from "./db.ts";
import { liftFreeze } from "./freeze.ts";
import { localTime } from "./intents/intent.ts";
import type { Intent, IntentStore } from "./intents/types.ts";
import { type ApplyCtx, apply, exitsOf, wait, waitKey } from "./machine.ts";
import { dataOf, type Mission, patchData, unfinishedFor } from "./mission.ts";
import { parseAllow, readingReply, reverseRefusals } from "./pipeline/access.ts";
import type { PipeData } from "./pipeline/common.ts";
import { missing, parseStored } from "./repo/readiness.ts";
import { recheck } from "./risk.ts";
import { changeScores, parseScoreWords, raiseToFull } from "./scores.ts";
import { checklist, type OwnerStep } from "./steps.ts";

export type CommandName =
  | "answer"
  | "retry"
  | "drop"
  | "pause"
  | "resume"
  | "start"
  | "done"
  | "steps"
  | "score"
  | "boost"
  | "unfreeze";

export interface CommandRow {
  id: number;
  name: CommandName;
  arg: string;
  text: string;
  source: string;
  created: number;
  applied_at: number | null;
  result: string | null;
  /** USR-8: who gave the command (a GitHub login) and through which channel; null for older rows. */
  actor?: string | null;
  via?: string | null;
}

export const MAX_ANSWER = 2000;

export function insertCommand(
  db: Db,
  c: { name: CommandName; arg?: string; text?: string; source: string; actor?: string; via?: string },
  now: number,
): number {
  if (c.name === "answer" && (!c.text?.trim() || c.text.length > MAX_ANSWER)) {
    throw new Error(`an answer is 1 to ${MAX_ANSWER} characters`);
  }
  return db.run(
    "INSERT INTO commands (name, arg, text, source, created, actor, via) VALUES (?, ?, ?, ?, ?, ?, ?)",
    c.name,
    c.arg ?? "",
    c.text ?? "",
    c.source,
    now,
    c.actor ?? null,
    c.via ?? null,
  ).lastId;
}

export function pendingCommands(db: Db): CommandRow[] {
  return db.all<CommandRow>("SELECT * FROM commands WHERE applied_at IS NULL ORDER BY id");
}

export function commandResult(db: Db, id: number): string | null {
  return db.get<{ result: string | null }>("SELECT result FROM commands WHERE id = ?", id)?.result ?? null;
}

export interface CommandCtx {
  db: Db;
  store: IntentStore;
  applyCtx: ApplyCtx;
  now: Date;
  /** `[intents].cutoff` (PRI-5), to say whether a score change parks the intent; default 7. */
  cutoff?: number;
}

/**
 * SHIP-22: tick (or untick) the owner's steps of an intent's unfinished mission, with the time, in one
 * transaction. The loop writes the ticks to `plan.md` and continues the wait. Returns the steps left.
 */
export function tickSteps(
  db: Db,
  intent: string,
  which: number[] | "all",
  done: boolean,
  now: Date,
  /** SHIP-34: Towercab itself ticks a secret step once its key exists; the owner can't. */
  auto = false,
): string {
  return db.tx(() => {
    const m = unfinishedFor(db, intent);
    const steps = dataOf<{ steps?: OwnerStep[] }>(m ?? ({ data: "{}" } as Mission)).steps ?? [];
    if (!m || steps.length === 0) throw new Error(`${intent} has no steps`);
    // SHIP-33: "all" leaves the secret steps to Towercab.
    const ns = which === "all" ? steps.filter((s) => auto || !s.secret).map((s) => s.n) : which;
    if (ns.length === 0) throw new Error(`${intent} has no steps you tick: its secrets tick themselves`);
    for (const n of ns) {
      const s = steps.find((x) => x.n === n);
      if (!s) throw new Error(`step ${n} isn't one of ${intent}'s steps`);
      if (done && s.secret && !auto)
        throw new Error(`step ${n} ticks itself once ${s.secret.key} exists in ${s.secret.file}`);
    }
    const at = localTime(now);
    const next = steps.map((s) => (ns.includes(s.n) ? { ...s, done_at: done ? at : null } : s));
    patchData(db, m, { steps: next, stepsDirty: ns.at(-1) }, now.getTime() / 1000);
    const left = next.filter((s) => !s.done_at);
    return left.length
      ? `${done ? "ticked" : "unticked"} ${ns.join(", ")}; steps left: ${checklist(next, "before")}${checklist(next, "before") && checklist(next, "after") ? "; " : ""}${checklist(next, "after")}`
      : `${done ? "ticked" : "unticked"} ${ns.join(", ")}; no steps left`;
  });
}

export function paused(db: Db): boolean {
  return db.meta("paused") === "1";
}

/** LOOP-114: `pause --now` was asked and the runs are still being stopped. */
export function pausedNow(db: Db): boolean {
  return db.meta("paused_now") === "1";
}

/** LOOP-113: the runs going now, whichever mission they belong to. */
export function runningSteps(db: Db): number {
  return (
    db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM missions WHERE child_pid IS NOT NULL AND stage NOT IN ('done','stopped','unverified')",
    )?.n ?? 0
  );
}

/** LOOP-113, LOOP-114: the words after "paused" while runs are going; empty when none. */
export function pausedSuffix(db: Db): string {
  const n = runningSteps(db);
  if (n === 0) return "";
  return pausedNow(db) ? `stopping ${n} running steps` : `${n} running steps finishing`;
}

/** SHD-22: whether one intent is paused (`pause <id>`): no further stage starts until it is resumed. */
export function intentPaused(db: Db, intent: string): boolean {
  return db.meta(`paused:${intent}`) === "1";
}

/** AUT-33: the commands the command line refuses on an a0 intent, as the rows they would insert. */
export const OWNER_ONLY_COMMANDS: readonly CommandName[] = [
  "answer",
  "start",
  "drop",
  "done",
  "retry",
  "steps",
  "resume",
  "score",
  "unfreeze",
];

/** An ignored reply or command noted on an a0 intent (AUT-32, AUT-33). */
export interface IgnoredNote {
  at: number;
  text: string;
}

/** AUT-32: note on the intent, once per `key` (a comment id, a command row), that something was ignored. */
export function noteIgnored(db: Db, intent: string, key: string, text: string, now: number): boolean {
  const k = `ignored:${intent}:${key}`;
  if (db.meta(k) !== null) return false;
  db.setMeta(k, JSON.stringify({ at: now, text } satisfies IgnoredNote));
  return true;
}

/** PIP-185, PIP-186: a comment under the owner's login that an agent marked. */
export interface AgentCommentNote {
  agent: string;
  url: string;
  /** Epoch seconds. */
  at: number;
  excerpt: string;
  /** Whether the intent acted on it (false at a0). */
  actedOn: boolean;
}

/** PIP-185: record the agent's comment once per `key` (the comment's id). */
export function recordAgentComment(db: Db, intent: string, key: string, c: AgentCommentNote): boolean {
  const k = `agentcomment:${intent}:${key}`;
  if (db.meta(k) !== null) return false;
  db.setMeta(k, JSON.stringify(c));
  return true;
}

/** PIP-186: the agent comments recorded on an intent, oldest first. */
export function agentCommentNotes(db: Db, intent: string): AgentCommentNote[] {
  return db
    .all<{ value: string }>("SELECT value FROM meta WHERE key LIKE ? ESCAPE '\\'", `agentcomment:${intent}:%`)
    .map((r) => JSON.parse(r.value) as AgentCommentNote)
    .sort((a, b) => a.at - b.at);
}

/** The notes of ignored replies on an intent, oldest first. */
export function ignoredNotes(db: Db, intent: string): IgnoredNote[] {
  return db
    .all<{ value: string }>("SELECT value FROM meta WHERE key LIKE ? ESCAPE '\\'", `ignored:${intent}:%`)
    .map((r) => JSON.parse(r.value) as IgnoredNote)
    .sort((a, b) => a.at - b.at);
}

/** Apply one command; its reply (or error text) is stored with it. */
export async function applyCommand(cx: CommandCtx, row: CommandRow): Promise<string> {
  let result: string;
  try {
    // AUT-35: no command changes autonomy (the table refuses the name); a row that claims to is dropped and noted.
    if ((row.name as string) === "autonomy") {
      noteIgnored(
        cx.db,
        row.arg || "-",
        `command:${row.id}`,
        `ignored "autonomy" from the ${row.source}: only you can raise autonomy`,
        cx.now.getTime() / 1000,
      );
      throw new Error("only you can raise autonomy: use GitHub or the page");
    }
    // LOOP-134: Boost raises autonomy, so like a raise it counts only from the page (AUT-35).
    if (row.name === "boost" && row.source !== "ui") {
      noteIgnored(
        cx.db,
        row.arg || "-",
        `command:${row.id}`,
        `ignored "boost" from the ${row.source}: only you can raise autonomy`,
        cx.now.getTime() / 1000,
      );
      throw new Error("only you can raise autonomy: use the page");
    }
    // AUT-33: only the page counts for an a0 intent; a row from anywhere else is dropped and noted.
    if (row.source !== "ui" && row.arg !== "" && OWNER_ONLY_COMMANDS.includes(row.name)) {
      const intent = await cx.store.get(row.arg).catch(() => null);
      if (intent && ownerOnly(levelNow(cx.db, intent))) {
        const at = cx.now.getTime() / 1000;
        noteIgnored(
          cx.db,
          intent.id,
          `command:${row.id}`,
          `ignored "${row.name}" from the ${row.source}: this intent is only yours`,
          at,
        );
        throw new Error(ownerOnlyLine(intent.id));
      }
    }
    result = await run(cx, row);
  } catch (e) {
    result = `${row.name}: ${(e as Error).message}`;
  }
  cx.db.run(
    "UPDATE commands SET applied_at = ?, result = ? WHERE id = ?",
    cx.now.getTime() / 1000,
    result,
    row.id,
  );
  return result;
}

export async function applyPending(cx: CommandCtx): Promise<{ id: number; result: string }[]> {
  const out: { id: number; result: string }[] = [];
  for (const row of pendingCommands(cx.db)) out.push({ id: row.id, result: await applyCommand(cx, row) });
  return out;
}

/** LOOP-63: mark an intent to start over the limits; refused when it is done, started or its repo is not ready. */
function startIntent(db: Db, intent: Intent): void {
  if (intent.stage === "dropped") throw new Error(`${intent.id} is done or dropped`);
  if (unfinishedFor(db, intent.id) || db.meta(`start:${intent.id}`) !== null) {
    throw new Error(`${intent.id} has already started`);
  }
  // LOOP-70: a blocking repo starts nothing but its setup intent.
  const ready = parseStored(db.meta(`readiness:${intent.repo}`))?.readiness;
  if (ready?.blocks && intent.setup !== true) {
    throw new Error(
      `${intent.repo} is not ready: ${missing(ready)
        .map((i) => i.item)
        .join(", ")}`,
    );
  }
  db.setMeta(`start:${intent.id}`, "1");
}

/** USR-8: the channel of a command: its `via`, else what its `source` means. */
const VIA: Record<string, string> = { ui: "page", cli: "cli", telegram: "telegram" };

async function run(cx: CommandCtx, row: CommandRow): Promise<string> {
  const { db, store } = cx;
  const by = { actor: row.actor ?? undefined, via: row.via ?? VIA[row.source] ?? row.source };
  switch (row.name) {
    case "pause": {
      if (row.arg !== "") {
        // SHD-22: one intent only; the rest of Towercab goes on.
        const intent = await store.get(row.arg);
        db.setMeta(`paused:${intent.id}`, "1");
        return `paused ${intent.id}: no further stage starts until you resume it`;
      }
      // UI-111: the time of the first pause, so the page can say since when.
      if (!paused(db)) db.setMeta("paused_at", cx.now.toISOString());
      db.setMeta("paused", "1");
      // LOOP-114: `--now` also stops the runs going; the loop does it on its next pass and forgets the flag.
      if (row.text === "now") {
        db.setMeta("paused_now", "1");
        return "paused now: nothing new starts, running steps are stopped, and GitHub is left alone until you resume";
      }
      return "paused: nothing new starts, and merges wait until you resume";
    }
    case "resume": {
      if (row.arg !== "") {
        const intent = await store.get(row.arg);
        db.delMeta(`paused:${intent.id}`);
        return `resumed ${intent.id}`;
      }
      db.delMeta("paused");
      db.delMeta("paused_at");
      db.delMeta("paused_now");
      const held = db.all<Mission>(
        "SELECT * FROM missions WHERE held = 1 AND stage NOT IN ('done','stopped','unverified')",
      );
      for (const m of held) {
        db.run("UPDATE missions SET held = 0 WHERE id = ?", m.id);
        apply(cx.applyCtx, { ...m, held: 0 }, { event: "resume", ...by });
      }
      return "resumed";
    }
    case "answer": {
      const intent = await store.get(row.arg);
      const m = unfinishedFor(db, intent.id);
      // PIP-141: `allow <path>` reverses a refusal, unless a test question is open (then it is its answer).
      const paths = parseAllow(row.text);
      if (paths && m && !(dataOf(m) as PipeData).testAsk && !(dataOf(m) as PipeData).accessAsk) {
        const r = reverseRefusals(dataOf(m) as PipeData, paths);
        await store.update(intent.id, "answer", (e) => e.addAnswer(row.text, cx.now));
        const said = readingReply({ allowed: r.moved, refused: [], undecided: [] });
        if (m.stage === "blocked") {
          apply(cx.applyCtx, m, { event: "answered", text: row.text, data: r.patch, ...by });
          return `${said}\nit continues`;
        }
        patchData(db, m, r.patch, cx.now.getTime() / 1000);
        return `${said}\nthe worker is told on its next run`;
      }
      if (paths && !m && !intent.waiting) {
        throw new Error(`${intent.id} has no running mission, so its tests can't be changed`);
      }
      if (!m && !intent.waiting) throw new Error(`${intent.id} isn't waiting on you`);
      // LOOP-77: a reply to a wait that came back with nothing new would only land on it again.
      if (m?.stage === "blocked" && (dataOf(m) as PipeData).stuck) {
        throw new Error(
          `${intent.id} is stuck at ${waitKey(m.waiting ?? "")}: a reply would land here again; use steps, done, retry or drop`,
        );
      }
      await store.update(intent.id, "answer", (e) => {
        e.addAnswer(row.text, cx.now);
        if (!m) e.removeField("waiting");
      });
      if (m?.stage === "blocked") {
        apply(cx.applyCtx, m, { event: "answered", text: row.text, ...by });
        return `answered ${intent.id}; it continues`;
      }
      return m ? `noted for ${intent.id}: the worker gets it with its next run` : `answered ${intent.id}`;
    }
    case "start": {
      const intent = await store.get(row.arg);
      startIntent(db, intent);
      return `starting ${intent.id}: its design begins on the next pass, over the limit if need be`;
    }
    case "score": {
      // LOOP-133, LOOP-135: `text` is `u=N i=N`, already checked by the CLI and the page.
      const r = await changeScores(
        { db, store, now: cx.now.getTime() / 1000, cutoff: cx.cutoff ?? 7 },
        row.arg,
        parseScoreWords(row.text.split(/\s+/).filter(Boolean)),
        row.source,
      );
      return r.message;
    }
    case "boost": {
      // LOOP-134: a5 first (one commit), then what `start` does for an intent without a mission.
      const { found } = await raiseToFull({ db, store, now: cx.now.getTime() / 1000 }, row.arg);
      if (unfinishedFor(db, found.id) || db.meta(`start:${found.id}`) !== null) {
        return `boosted ${found.id}: a5 from its next gate`;
      }
      if (intentPaused(db, found.id)) {
        return `boosted ${found.id}: a5; it is paused, so it starts when you resume it`;
      }
      try {
        startIntent(db, found);
      } catch (e) {
        return `boosted ${found.id}: a5; not started: ${(e as Error).message}`;
      }
      return `boosted ${found.id}: a5, and its design begins on the next pass, over the limit if need be`;
    }
    case "retry": {
      const intent = await store.get(row.arg);
      const m = unfinishedFor(db, intent.id);
      if (m) {
        const again = recheck(m);
        if (again) {
          apply(cx.applyCtx, m, { ...again, ...by });
          return `running the risk check of ${intent.id} again`;
        }
        const fresh = apply(cx.applyCtx, m, { event: "retry_fresh", ...by });
        return `fresh attempt ${fresh.attempt} for ${intent.id}`;
      }
      await store.update(intent.id, "retry", (e) => {
        e.removeField("stage");
        e.removeField("waiting");
        e.removeField("retry");
      });
      return `${intent.id} is queued for a fresh attempt`;
    }
    case "unfreeze": {
      // LOOP-81: lift the freeze the intent holds; nothing freezes again until the owner asks.
      const intent = await store.get(row.arg);
      const m = unfinishedFor(db, intent.id);
      const offered = m?.stage === "blocked" && exitsOf(m.waiting ?? "").some((e) => e.do === "unfreeze");
      if (!m || !offered) throw new Error(`${intent.id} isn't at a freeze that can be lifted`);
      const freed = liftFreeze(db, m.id);
      apply(cx.applyCtx, m, wait("freeze lifted", "You lifted the freeze; freeze again when you are ready."));
      return `unfroze ${intent.id}${freed.length ? ` (${freed.join(", ")})` : ""}`;
    }
    case "done": {
      // LOOP-76: the owner did the work themselves; their note becomes a ticked step of the plan.
      const intent = await store.get(row.arg);
      const m = unfinishedFor(db, intent.id);
      if (!m) throw new Error(`${intent.id} isn't waiting on you`);
      const code = (dataOf(m) as PipeData).delivery !== "steps";
      const at0 = m.stage === "steps" ? "your steps" : m.stage === "blocked" ? (m.waiting ?? "") : "";
      const offered = at0 !== "" && exitsOf(at0, false, code).some((e) => e.do === "done");
      if (!offered) throw new Error(`${intent.id} isn't at a wait where "I did it myself" applies`);
      const at = localTime(cx.now);
      const note = row.text.trim() || "Done by the owner";
      const old = (dataOf(m) as PipeData).steps ?? [];
      const steps: OwnerStep[] = [
        // Steps needed before a merge may not have happened: only the ones after it count as done.
        ...old.map((s) => (s.done_at || s.when === "before" ? s : { ...s, done_at: at })),
        { n: old.length + 1, when: "after", text: note, why: "", done_at: at },
      ];
      // One write: the steps go with the move, so a refused move leaves nothing behind.
      apply(cx.applyCtx, m, {
        event: "owner_done",
        ...by,
        why: "the owner did it themselves",
        data: { steps, stepsDirty: steps.length },
      });
      return `${intent.id} is done: ${note}`;
    }
    case "steps": {
      // PIP-113: the owner does it by hand; the delivery becomes steps.
      const intent = await store.get(row.arg);
      const m = unfinishedFor(db, intent.id);
      if (!m) throw new Error(`${intent.id} isn't waiting on you`);
      const offered = m.stage === "blocked" && exitsOf(m.waiting ?? "").some((e) => e.do === "steps");
      if (!offered) throw new Error(`${intent.id} isn't at a wait where it can become steps`);
      // Steps have no merge, so every step comes "after".
      const steps = ((dataOf(m) as PipeData).steps ?? []).map((s) => ({ ...s, when: "after" as const }));
      const out = apply(cx.applyCtx, m, {
        event: "to_steps",
        ...by,
        why: "the owner will do it by hand",
        data: { delivery: "steps", steps },
        // A plan made again opens a new plan PR; the merged one is not reused.
        set: steps.length ? {} : { plan_pr: null },
      });
      return out.stage === "steps"
        ? `${intent.id} is now steps for you to do`
        : `${intent.id} goes back to its plan to list the steps you will do`;
    }
    case "drop": {
      const intent = await store.get(row.arg);
      const m = unfinishedFor(db, intent.id);
      if (m) apply(cx.applyCtx, m, { event: "intent_removed", why: "dropped", ...by });
      await store.update(intent.id, "drop", (e) => {
        e.setField("stage", "dropped");
        e.removeField("waiting");
      });
      return `dropped ${intent.id}`;
    }
  }
}
