// The shadow's records (SHD-15, SHD-19): the conversation (`shadow_turns`), what it did
// (`shadow_actions`) and its small state in `meta`. Everything here is synchronous and runs in the
// caller's transaction when it has one.

import type { Config } from "../config.ts";
import type { Db } from "../db.ts";

export const SESSION = "shadow.session";
export const SUMMARY = "shadow.summary";
export const PENDING = "shadow.pending";
export const EPOCH = "shadow.epoch";
export const STARTED = "shadow.started";
export const CAPPED = "shadow.capped";
export const OFFSET = "telegram.offset";

/** SHD-19: how long the action log is kept. */
export const KEEP_S = 30 * 86_400;

export interface Turn {
  id: number;
  update_id: number | null;
  at: number;
  role: "owner" | "shadow";
  text: string;
  state: "pending" | "done" | "skipped" | "failed";
  cost: number;
  folded: number;
}

export type Outcome = "started" | "held" | "done" | "refused";

export interface ActionRow {
  id: number;
  at: number;
  turn: number | null;
  idx: number;
  action: string;
  intent: string;
  pr: number;
  outcome: Outcome;
  detail: string;
}

/** SHD-10: an action waiting for the owner's yes. */
export interface Pending {
  /** The `shadow_actions` row that holds it. */
  row: number;
  action: string;
  intent: string;
  repo: string;
  title: string;
  text: string;
  at: number;
}

export const offset = (db: Db): number => Number(db.meta(OFFSET) ?? 0) || 0;

export function epoch(db: Db): number {
  return Number(db.meta(EPOCH) ?? 0) || 0;
}

/** The unix time of local midnight at or before `now`. */
export function dayStart(now: number): number {
  const d = new Date(now * 1000);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000;
}

/** An owner message, once per Telegram update (SHD-20). False when `update` was stored before. */
export function addOwnerTurn(db: Db, update: number, text: string, at: number): boolean {
  return (
    db.run(
      "INSERT OR IGNORE INTO shadow_turns (update_id, at, role, text, state) VALUES (?, ?, 'owner', ?, 'pending')",
      update,
      at,
      text,
    ).changes > 0
  );
}

export function nextTurn(db: Db): Turn | undefined {
  return db.get<Turn>(
    "SELECT * FROM shadow_turns WHERE role = 'owner' AND state = 'pending' ORDER BY id LIMIT 1",
  );
}

export function getTurn(db: Db, id: number): Turn | undefined {
  return db.get<Turn>("SELECT * FROM shadow_turns WHERE id = ?", id);
}

export function setTurnState(db: Db, id: number, state: Turn["state"]): void {
  db.run("UPDATE shadow_turns SET state = ? WHERE id = ?", state, id);
}

export function addCost(db: Db, id: number, usd: number): void {
  if (usd > 0) db.run("UPDATE shadow_turns SET cost = cost + ? WHERE id = ?", usd, id);
}

/** The conversation not yet folded into the summary, oldest first. */
export function liveTurns(db: Db): Turn[] {
  return db.all<Turn>("SELECT * FROM shadow_turns WHERE folded = 0 ORDER BY id");
}

/** Today's shadow cost (every turn's runs). */
export function costToday(db: Db, now: number): number {
  return (
    db.get<{ n: number | null }>("SELECT SUM(cost) AS n FROM shadow_turns WHERE at >= ?", dayStart(now))?.n ??
    0
  );
}

/** A message for the owner, through the outbox (LOOP-16): sent once per `key`, retried until it is. */
export function tell(db: Db, key: string, text: string, now: number): void {
  db.run("INSERT OR IGNORE INTO outbox (key, mission, text, created) VALUES (?, NULL, ?, ?)", key, text, now);
}

/** Finish an owner turn: it is done and the reply is stored and queued, together (SHD-20). */
export function finishTurn(
  db: Db,
  turn: number,
  update: number | null,
  text: string,
  now: number,
  state: Turn["state"] = "done",
): void {
  db.tx(() => {
    setTurnState(db, turn, state);
    db.run("INSERT INTO shadow_turns (at, role, text, state) VALUES (?, 'shadow', ?, 'done')", now, text);
    tell(db, `shadow:${update ?? `t${turn}`}`, text, now);
  });
}

export function pendingActions(db: Db): Pending[] {
  try {
    const v = JSON.parse(db.meta(PENDING) ?? "[]") as unknown;
    return Array.isArray(v) ? (v as Pending[]) : [];
  } catch {
    return [];
  }
}

export function savePending(db: Db, list: Pending[]): void {
  if (list.length) db.setMeta(PENDING, JSON.stringify(list));
  else db.delMeta(PENDING);
}

export function recordAction(
  db: Db,
  a: {
    at: number;
    turn: number | null;
    idx: number;
    action: string;
    intent: string;
    pr: number;
    outcome: Outcome;
    detail?: string;
  },
): number {
  return db.run(
    "INSERT INTO shadow_actions (at, turn, idx, action, intent, pr, outcome, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    a.at,
    a.turn,
    a.idx,
    a.action,
    a.intent,
    a.pr,
    a.outcome,
    a.detail ?? "",
  ).lastId;
}

export function setOutcome(db: Db, id: number, outcome: Outcome, detail = ""): void {
  db.run("UPDATE shadow_actions SET outcome = ?, detail = ? WHERE id = ?", outcome, detail, id);
}

export function actionsOfTurn(db: Db, turn: number): ActionRow[] {
  return db.all<ActionRow>("SELECT * FROM shadow_actions WHERE turn = ? ORDER BY idx", turn);
}

export function recentActions(db: Db, n: number): ActionRow[] {
  return db.all<ActionRow>(
    "SELECT * FROM shadow_actions WHERE outcome != 'started' ORDER BY at DESC, id DESC LIMIT ?",
    n,
  );
}

export function actionsFor(db: Db, intent: string): ActionRow[] {
  return db.all<ActionRow>("SELECT * FROM shadow_actions WHERE intent = ? ORDER BY at, id", intent);
}

const PAST: Record<string, string> = {
  reply: "Replied on",
  start: "Started",
  draft: "Drafted",
  merge: "Merged",
  boost: "Boosted",
  drop: "Dropped",
  confirm: "Confirmed",
};

/** UI-236, UI-237: a row as one sentence, without the tag. */
export function actionSentence(a: Pick<ActionRow, "action" | "intent" | "outcome" | "detail">): string {
  const on = a.intent ? ` ${a.intent}` : "";
  if (a.outcome === "held") return `Waiting for your yes in Telegram: ${a.action}${on}`;
  if (a.outcome === "refused") return `Didn't ${a.action}${on}${a.detail ? `: ${a.detail}` : ""}`;
  return `${PAST[a.action] ?? a.action}${on}`;
}

export function prune(db: Db, now: number): void {
  db.run("DELETE FROM shadow_actions WHERE at < ?", now - KEEP_S);
}

/** SHD-17: the conversation, summary, session and pending actions go; the action log stays. */
export function resetShadow(db: Db): void {
  db.tx(() => {
    db.run("DELETE FROM shadow_turns");
    for (const k of [SESSION, SUMMARY, PENDING, STARTED, CAPPED]) db.delMeta(k);
    db.setMeta(EPOCH, String(epoch(db) + 1));
  });
}

function ago(s: number): string {
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129_600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} days ago`;
}

/** LOOP-131: what `/status` and `towercab shadow status` say. */
export function statusText(db: Db, cfg: Config["shadow"], now: number): string {
  const turns = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM shadow_turns")?.n ?? 0;
  const started = Number(db.meta(STARTED) ?? 0);
  const pending = pendingActions(db);
  const spent = costToday(db, now);
  const lines = [
    cfg.enabled ? "The shadow is on." : "The shadow is off ([shadow] enabled in the config turns it on).",
    db.meta(SESSION) && started
      ? `Conversation: ${turns} messages, session started ${ago(now - started)}.`
      : `Conversation: ${turns} messages, no session yet.`,
    pending.length
      ? `Waiting for your yes: ${pending.map((p) => `${p.action} ${p.intent}`).join("; ")}.`
      : "Waiting for your yes: nothing.",
    `Today: $${spent.toFixed(2)} of $${cfg.dailyBudgetUsd.toFixed(2)}.`,
  ];
  return lines.join("\n");
}
