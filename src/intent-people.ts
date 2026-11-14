// Who wrote an intent and who confirmed it (AUT-23, USR-8). Kept with the mission's database, never in the
// intent file, so nobody can type a role into a line. The writer is set once: a later edit changes nothing.

import type { Db } from "./db.ts";
import { rank, roleOn } from "./users.ts";
import { getUser } from "./users-store.ts";

export interface IntentPeople {
  writer: string | null;
  confirmedBy: string | null;
  confirmedAt: number | null;
}

/** AUT-23: the writer, once. `null` is an intent no verified account wrote: it has no writer and stays so. */
export function recordWriter(db: Db, intent: string, writer: string | null, now: number): void {
  db.run(
    "INSERT OR IGNORE INTO intent_people (intent, writer, at) VALUES (?, ?, ?)",
    intent,
    writer ? writer.toLowerCase() : null,
    now,
  );
}

export function peopleOf(db: Db, intent: string): IntentPeople | null {
  const r = db.get<{ writer: string | null; confirmed_by: string | null; confirmed_at: number | null }>(
    "SELECT writer, confirmed_by, confirmed_at FROM intent_people WHERE intent = ?",
    intent,
  );
  return r ? { writer: r.writer, confirmedBy: r.confirmed_by, confirmedAt: r.confirmed_at } : null;
}

/** AUT-23: a maintainer or admin confirms an intent; the first confirmation stands. */
export function confirmIntent(db: Db, intent: string, login: string, now: number): boolean {
  recordWriter(db, intent, null, now);
  const done = db.run(
    "UPDATE intent_people SET confirmed_by = ?, confirmed_at = ? WHERE intent = ? AND confirmed_by IS NULL",
    login.toLowerCase(),
    now,
    intent,
  );
  return done.changes > 0;
}

/**
 * AUT-23: the highest rank (viewer 0 … admin 3) among the writer and the confirmer on `repo` now, so a role
 * change applies at the next gate; -1 when there is no writer or confirmer who is an enabled person.
 */
export function authorityOf(db: Db, intent: string, repo: string): number {
  const p = peopleOf(db, intent);
  if (!p) return -1;
  let best = -1;
  for (const login of [p.writer, p.confirmedBy]) {
    const u = login ? getUser(db, login) : null;
    if (u && !u.disabled) best = Math.max(best, rank(roleOn(u, repo)));
  }
  return best;
}

const MAINTAINER = rank("maintainer");
const CONTRIBUTOR = rank("contributor");

/** AUT-23: may run at all: a contributor or above wrote or confirmed it. */
export const mayStart = (authority: number): boolean => authority >= CONTRIBUTOR;
/** AUT-23: may reach a5: a maintainer or admin wrote or confirmed it. */
export const mayFull = (authority: number): boolean => authority >= MAINTAINER;
