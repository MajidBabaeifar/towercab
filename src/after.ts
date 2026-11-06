// LOOP-117..119: a mission at build waits for the intents its intent file says it comes `after`.
// Pure: the loop reads the listing and acts on what these return.

import type { Intent, Listing } from "./intents/types.ts";
import { afterChecker } from "./pick.ts";

/** LOOP-119: how long a mission may wait for an unfinished intent before the owner is told. */
export const HOLD_SECONDS = 3 * 86400;

/** What a held mission remembers of its hold (`data.afterHold`). */
export interface AfterHold {
  /** Unix s the mission was first held for this list. */
  since: number;
  /** The `after` list when last read. */
  list: string[];
  /** The owner has been told (LOOP-119); never told twice for one hold. */
  notified?: boolean;
  /** `waiting for <id>: <stage>`, as status and the pages show it. */
  text: string;
}

export interface Blocker {
  id: string;
  /** Where that intent is now, in plain words. */
  where: string;
}

export interface AfterState {
  /** Unknown or cyclic IDs (`bad after:`, LOOP-5). */
  bad: string[];
  /** Listed intents that are not done, in list order. */
  blockers: Blocker[];
  /** Blockers that were rolled back. */
  rolledBack: string[];
  /** Blockers that were dropped. */
  dropped: string[];
}

/** The listed intents of `intent` that are not done yet, against the current listing. */
export function afterState(listing: Listing, intent: Pick<Intent, "id" | "after">): AfterState {
  const list = [...new Set(intent.after)];
  const bad = afterChecker(listing)(intent.id, list, false);
  const blockers: Blocker[] = [];
  const rolledBack: string[] = [];
  const dropped: string[] = [];
  for (const id of list) {
    if (listing.doneIds.has(id) || bad.includes(id)) continue;
    const other = listing.open.find((i) => i.id === id);
    if (listing.droppedIds.has(id)) dropped.push(id);
    if (other?.waiting?.startsWith("rolled back")) rolledBack.push(id);
    blockers.push({ id, where: other?.waiting ?? other?.stage ?? "not started yet" });
  }
  return { bad, blockers, rolledBack, dropped };
}

/** `waiting for <id>: <where>`, with `(+n more)` when several are unfinished. */
export function heldText(blockers: Blocker[]): string {
  const [first, ...rest] = blockers;
  if (!first) return "";
  return `waiting for ${first.id}: ${first.where}${rest.length ? ` (+${rest.length} more)` : ""}`;
}

/** The hold after this read: the first one starts now; an added ID starts the 3 days again. */
export function nextHold(prev: AfterHold | undefined, list: string[], text: string, now: number): AfterHold {
  const ids = [...new Set(list)];
  if (!prev || ids.some((id) => !prev.list.includes(id))) return { since: now, list: ids, text };
  return { ...prev, list: ids, text };
}

/** LOOP-119: why the owner must be told now, or null (quiet). */
export function holdTrigger(hold: AfterHold, s: AfterState, now: number): string | null {
  if (hold.notified) return null;
  const [r] = s.rolledBack;
  if (r) return `${r} was rolled back`;
  const [d] = s.dropped;
  if (d) return `${d} was dropped`;
  const [b] = s.blockers;
  if (b && now - hold.since >= HOLD_SECONDS) return `${b.id} is still ${b.where} after 3 days`;
  return null;
}
