// Changing an intent's autonomy (AUT-34, AUT-35): the last level the owner accepted, and the flag on a raise
// that someone else made in the intents repo. Both live in `meta`; the intent file stays the one source of `a`.

import { defaultLevel } from "./autonomy.ts";
import type { Db } from "./db.ts";
import type { Intent } from "./intents/types.ts";

/** AUT-35: a raise that doesn't count until the owner decides. */
export interface RaiseFlag {
  /** The GitHub account that raised it, or `unknown`. */
  who: string;
  /** The accepted level the mission keeps using. */
  from: number;
  to: number;
  commit: string;
  at: number;
}

const acceptedKey = (id: string) => `a-accepted:${id}`;
const flagKey = (id: string) => `a-flag:${id}`;

/** The last level the owner accepted (resolved: a missing line is the default), or null before the first look. */
export function acceptedOf(db: Db, id: string): number | null {
  const v = db.meta(acceptedKey(id));
  return v === null ? null : Number(v);
}

export function setAccepted(db: Db, id: string, a: number): void {
  db.setMeta(acceptedKey(id), String(a));
}

export function flagOf(db: Db, id: string): RaiseFlag | null {
  const v = db.meta(flagKey(id));
  return v === null ? null : (JSON.parse(v) as RaiseFlag);
}

export function setFlag(db: Db, id: string, f: RaiseFlag): void {
  db.setMeta(flagKey(id), JSON.stringify(f));
}

export function clearFlag(db: Db, id: string): void {
  db.delMeta(flagKey(id));
}

type Leveled = Pick<Intent, "id" | "a"> & { source?: string | null };

/**
 * AUT-8, AUT-35: the level the intent runs at now. A written level above the accepted one is a raise nobody
 * has judged yet (no flag until the next poll, none at all while GitHub can't answer): the accepted level
 * holds until the owner's raise is recognised or the owner accepts it. Else the intent's own `a`.
 */
export function levelNow(db: Db, i: Leveled): number | null {
  const acc = acceptedOf(db, i.id);
  if (acc !== null && writtenLevel({ a: i.a, source: i.source ?? null }) > acc) return acc;
  const f = flagOf(db, i.id);
  return f ? f.from : i.a;
}

/** The intent as the pipeline sees it: a raise that isn't judged the owner's yet does not count. */
export function withFlag<T extends Leveled>(db: Db, i: T): T {
  const a = levelNow(db, i);
  return a === i.a ? i : { ...i, a };
}

/** UI-257, AUT-34: a change made on the page, for the Activity page and the intent's timeline. */
export interface LevelChange {
  intent: string;
  from: number;
  to: number;
  at: number;
}

export function recordChange(db: Db, c: LevelChange): void {
  db.setMeta(`a-change:${c.intent}:${c.at}`, JSON.stringify(c));
}

export function changesOf(db: Db, intent?: string): LevelChange[] {
  return db
    .all<{ value: string }>(
      "SELECT value FROM meta WHERE key LIKE ? ESCAPE '\\'",
      intent ? `a-change:${intent}:%` : "a-change:%",
    )
    .map((r) => JSON.parse(r.value) as LevelChange)
    .sort((a, b) => a.at - b.at);
}

/** The level an intent's file says, a missing line resolved to its default. */
export function writtenLevel(i: Pick<Intent, "a" | "source">): number {
  return i.a ?? defaultLevel(i.source);
}

export interface RaiseVerdict {
  owner: boolean;
  who: string;
}

/**
 * AUT-35: whether the GitHub accounts GitHub reports for the commit include the owner's. The commit's own
 * name and e-mail are never read. No account (null, or the host couldn't say) is not the owner.
 */
export function judgeRaise(logins: (string | null)[] | null, me: string): RaiseVerdict {
  const named = (logins ?? []).filter((l): l is string => !!l);
  const owner = named.some((l) => l.toLowerCase() === me.toLowerCase());
  return { owner, who: owner ? me : (named[0] ?? "unknown") };
}

export interface Seen {
  /** What to do with the flag after this look. */
  action: "seed" | "none" | "accept" | "judge";
}

/**
 * AUT-35: compare the level the file says with the accepted one. `seed`: first look, nothing to flag;
 * `accept`: not higher than the accepted level, so it is taken as is (and a flag ends); `judge`: a raise.
 */
export function seen(db: Db, i: Pick<Intent, "id" | "a" | "source">): Seen & { now: number } {
  const now = writtenLevel(i);
  const acc = acceptedOf(db, i.id);
  if (acc === null) return { action: "seed", now };
  if (now > acc) return { action: "judge", now };
  if (now < acc || flagOf(db, i.id)) return { action: "accept", now };
  return { action: "none", now };
}
