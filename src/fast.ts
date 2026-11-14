// The fast lane's mark and who confirmed it (FAST-1, FAST-9). The mark is `fast: true` in the intent file.
// It reorders work from any channel, but it skips the owner's approvals (`gateLevel`) only once the owner
// confirmed it: from the page, from their own Telegram chat, or by a commit GitHub verifies as theirs. The
// command line, which agents can run too, never confirms.

import { ownerOnly } from "./autonomy.ts";
import { levelNow } from "./autonomy-change.ts";
import type { Db } from "./db.ts";
import { type IntentStore, NoOpenIntentError } from "./intents/types.ts";

/** Where a mark comes from. `page` and `telegram` are the owner speaking; `cli` is not provably so. */
export type FastChannel = "page" | "telegram" | "cli";

const okKey = (id: string) => `fast-ok:${id}`;
const cliKey = (id: string) => `fast-cli:${id}`;
const seenKey = (id: string) => `fast-seen:${id}`;

/** Whether the owner confirmed this intent's mark (FAST-9). */
export function fastConfirmed(db: Db, id: string): boolean {
  return db.meta(okKey(id)) !== null;
}

export function confirmFast(db: Db, id: string): void {
  db.setMeta(okKey(id), "1");
  db.delMeta(cliKey(id));
}

export function clearFast(db: Db, id: string): void {
  db.delMeta(okKey(id));
  db.delMeta(cliKey(id));
  db.delMeta(seenKey(id));
}

/** The mark came in through the command line: the watch must not credit its commit to the owner's account. */
export function fastFromCli(db: Db, id: string): boolean {
  return db.meta(cliKey(id)) !== null;
}

/** The last commit of the mark the watch judged, so GitHub is asked once per commit. */
export function seenFast(db: Db, id: string): string | null {
  return db.meta(seenKey(id));
}

export function setSeenFast(db: Db, id: string, commit: string): void {
  db.setMeta(seenKey(id), commit);
}

export interface FastCx {
  db: Db;
  store: IntentStore;
}

/**
 * FAST-1, FAST-9: mark an intent (or take the mark off). Done or dropped intents are refused, and an a0
 * intent from any channel but the page. The owner's channels confirm the mark, also on an intent that is
 * marked already (the page's confirm click); the command line writes the mark and confirms nothing.
 * Taking the mark off clears the confirmation from every channel.
 */
export async function markFast(cx: FastCx, id: string, on: boolean, channel: FastChannel): Promise<string> {
  let found: Awaited<ReturnType<IntentStore["get"]>>;
  try {
    found = await cx.store.get(id);
  } catch (e) {
    if (e instanceof NoOpenIntentError) throw new Error(`fast: ${id} is done or dropped`);
    throw e;
  }
  if (found.done) throw new Error(`fast: ${found.id} is done or dropped`);
  if (channel !== "page" && ownerOnly(levelNow(cx.db, found))) {
    throw new Error(`fast: ${found.id} is a0, only you decide it on the page`);
  }
  const owner = channel === "page" || channel === "telegram";
  if (!on) {
    // The confirmation goes first: an unmarked intent must never keep one a later mark could inherit.
    clearFast(cx.db, found.id);
    if (found.fast) await cx.store.update(found.id, "fast off", (e) => e.removeField("fast"));
    return `${found.id} is out of the fast lane.`;
  }
  if (found.fast) {
    if (!owner) return `${found.id} is already in the fast lane.`;
    if (fastConfirmed(cx.db, found.id)) return `${found.id} is already in the fast lane.`;
    confirmFast(cx.db, found.id);
    return `${found.id} is in the fast lane: you confirmed it.`;
  }
  // The owner's confirmation lands before the push, so the watch never judges Towercab's own commit.
  if (owner) confirmFast(cx.db, found.id);
  else {
    clearFast(cx.db, found.id);
    cx.db.setMeta(cliKey(found.id), "1");
  }
  try {
    await cx.store.update(found.id, "fast", (e) => e.setField("fast", true));
  } catch (e) {
    clearFast(cx.db, found.id);
    throw e;
  }
  return owner
    ? `${found.id} is in the fast lane.`
    : `${found.id} is in the fast lane: it starts first, but its approvals wait for your confirmation on the page.`;
}
