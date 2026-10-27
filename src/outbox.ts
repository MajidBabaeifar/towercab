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
}

/** Where messages go (Telegram; tests fake it). Rejects when the message wasn't sent. */
export interface Sender {
  send(text: string): Promise<void>;
}

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
  const rows = db.all<OutboxRow>("SELECT * FROM outbox WHERE sent_at IS NULL ORDER BY created, rowid");
  const out: SendResult = { sent: 0, dropped: 0, failed: null };
  for (const row of rows) {
    if (isObsolete(row)) {
      db.run("UPDATE outbox SET sent_at = 0 WHERE key = ?", row.key);
      out.dropped++;
      continue;
    }
    if (row.next_try > now) break;
    try {
      await sender.send(row.text);
    } catch (e) {
      db.run(
        "UPDATE outbox SET tries = ?, next_try = ? WHERE key = ?",
        row.tries + 1,
        now + envBackoff(row.tries),
        row.key,
      );
      out.failed = e instanceof Error ? e.message : String(e);
      break;
    }
    db.run("UPDATE outbox SET sent_at = ? WHERE key = ?", now, row.key);
    out.sent++;
  }
  return out;
}
