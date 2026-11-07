// Sending messages (LOOP-14, LOOP-16): `outbox` rows (written by `machine.apply` with the move that
// causes them) go oldest first, stop at the first failure and retry with LOOP-10's backoff.

import type { Db } from "./db.ts";
import { envBackoff, finished, waitKey } from "./machine.ts";
import { getMission } from "./mission.ts";

export interface OutboxRow {
  key: string;
  mission: number | null;
  text: string;
  created: number;
  sent_at: number | null;
  tries: number;
  next_try: number;
  /** LOOP-128: `info`, `focus`, `edit` (an `editMessageText`) or `answer` (an `answerCallbackQuery`); a wait has a mission. */
  kind?: string;
  intent?: string | null;
  wait?: string | null;
  tg_message_id?: number | null;
  /** For `edit` the message id, for `answer` the callback id. */
  target?: string | null;
  /** JSON `Button[][]`, or null. */
  buttons?: string | null;
  /** When the wait the message is about ended (it is not edited again). */
  ended_at?: number | null;
}

/** One inline-keyboard button: its label and `callback_data` (TG-3). */
export interface Button {
  text: string;
  data: string;
}

/** Telegram refused an edit or an answer (message gone or too old): drop it, it will never work. */
export class Refused extends Error {}

/** Where messages go (Telegram; tests fake it). Rejects when the message wasn't sent. */
export interface Sender {
  /** Resolves with the Telegram message id when it has one. */
  send(text: string, buttons?: Button[][]): Promise<number | undefined | void>;
  edit?(message: number, text: string, buttons?: Button[][]): Promise<void>;
  answer?(callback: string, text: string): Promise<void>;
  /** LOOP-128: the text and buttons a wait's row has when it goes out, or null for the stored text. */
  prepare?(row: OutboxRow): Promise<{ text: string; buttons?: Button[][] } | null>;
}

/** LOOP-128: rows whose wait ended are kept this long. */
export const KEEP_SECONDS = 30 * 86400;

export interface SendResult {
  sent: number;
  /** Rows whose wait was over (`sent_at = 0`). */
  dropped: number;
  /** The failure that stopped this round, or null. */
  failed: string | null;
}

/**
 * A wait's row (`<mission>:<wait>:<continued>`) whose wait is over: the mission is gone or finished,
 * no longer waits, waits for another reason, or has left and re-entered the wait since. Rows of
 * other messages (no mission) never are.
 */
export function waitObsolete(db: Db): (row: OutboxRow) => boolean {
  return (row) => {
    if (row.mission === null) return false;
    const m = getMission(db, row.mission);
    if (!m || finished(m.stage) || !m.waiting) return true;
    const first = row.key.indexOf(":");
    const last = row.key.lastIndexOf(":");
    if (first < 0 || last <= first) return false;
    const wait = row.key.slice(first + 1, last);
    const n = row.key.slice(last + 1);
    return waitKey(m.waiting) !== wait || String(m.continued) !== n;
  };
}

/**
 * Unsent rows, oldest first: obsolete ones dropped (`sent_at = 0`); the rest sent until the first
 * failure or a row whose retry isn't due, which holds the ones after it. Sent: `sent_at = now`;
 * failed: `tries + 1`, `next_try = now + 30/60/120/240/300 s`. A failure never throws.
 */
export async function sendDue(
  db: Db,
  sender: Sender,
  now: number,
  isObsolete: (row: OutboxRow) => boolean = waitObsolete(db),
): Promise<SendResult> {
  // LOOP-128: old rows go; a press is answered ahead of everything else, so its button stops spinning.
  db.run(
    "DELETE FROM outbox WHERE sent_at IS NOT NULL AND COALESCE(NULLIF(sent_at, 0), created) < ? AND (kind IN ('edit', 'answer', 'info') OR ended_at IS NOT NULL OR tg_message_id IS NULL)",
    now - KEEP_SECONDS,
  );
  const rows = db.all<OutboxRow>(
    "SELECT * FROM outbox WHERE sent_at IS NULL ORDER BY (kind = 'answer') DESC, created, rowid",
  );
  const out: SendResult = { sent: 0, dropped: 0, failed: null };
  for (const row of rows) {
    if (isObsolete(row)) {
      db.run("UPDATE outbox SET sent_at = 0 WHERE key = ?", row.key);
      out.dropped++;
      continue;
    }
    if (row.next_try > now && row.kind !== "answer") break;
    let sentId: number | undefined;
    let text = row.text;
    let buttons: Button[][] | undefined = row.buttons ? (JSON.parse(row.buttons) as Button[][]) : undefined;
    try {
      if (row.kind === "answer") {
        if (!sender.answer) throw new Refused("no answers");
        await sender.answer(row.target ?? "", row.text);
      } else if (row.kind === "edit") {
        if (!sender.edit) throw new Refused("no edits");
        await sender.edit(Number(row.target), row.text, buttons);
      } else {
        const p = await sender.prepare?.(row);
        if (p) {
          text = p.text;
          buttons = p.buttons;
        }
        const id = await sender.send(text, buttons);
        if (typeof id === "number") sentId = id;
      }
    } catch (e) {
      if (e instanceof Refused) {
        db.run("UPDATE outbox SET sent_at = 0 WHERE key = ?", row.key);
        out.dropped++;
        continue;
      }
      db.run(
        "UPDATE outbox SET tries = ?, next_try = ? WHERE key = ?",
        row.tries + 1,
        now + envBackoff(row.tries),
        row.key,
      );
      out.failed = e instanceof Error ? e.message : String(e);
      break;
    }
    db.run(
      "UPDATE outbox SET sent_at = ?, text = ?, buttons = ?, tg_message_id = ? WHERE key = ?",
      now,
      text,
      buttons?.length ? JSON.stringify(buttons) : null,
      sentId ?? null,
      row.key,
    );
    out.sent++;
  }
  return out;
}
