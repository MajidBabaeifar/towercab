// The Inbox (UI-259 to UI-264): every wait on the owner in one list, with what is new since the owner's last
// visit and what they snoozed. It reads the waits the needs-you cards show, the reached caps and the proposed
// intents; its only state is the owner's last visit and snoozes, kept in `meta` (UI-264), never in a mission.

import type { Db } from "../db.ts";
import { writerOf } from "../users/writer.ts";
import { capCards } from "./budget-view.ts";
import { proposedSection } from "./proposed.ts";
import {
  dbMark,
  historyOf,
  needCounts,
  overviewOf,
  snapshot,
  type UiSources,
  versionOf,
  waitsOf,
} from "./state.ts";
import type { InboxItem, InboxPage } from "./view.ts";

const LAST_VISIT = "inbox:last_visit";
const SNOOZE = "inbox:snooze:";
/** UI-264: a snooze reaches at most this far. */
export const MAX_SNOOZE_SECS = 30 * 86_400;

/** One thing that could be listed, with what the ranking needs. */
export interface Candidate {
  key: string;
  /** 1 for a proposed intent that would be parked or can't be read: after every other wait. */
  rank: number;
  priority: number;
  /** When the wait began (unix s); infinite when unknown. */
  since: number;
  item: InboxItem;
}

/** UI-193: highest priority first, then the oldest wait, then the key, so the order never flips. */
export function byInbox(a: Candidate, b: Candidate): number {
  return (
    a.rank - b.rank ||
    b.priority - a.priority ||
    (a.since === b.since ? 0 : a.since < b.since ? -1 : 1) ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
}

/** A key the page and URL can carry: an intent ID, `proposed-<PR>` or `cap-<scope>-<period>`. */
const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80);

interface State {
  lastVisit: number | null;
  /** Item key → wake time (unix s), expired ones included until the owner next looks. */
  snoozes: Map<string, number>;
}

export function inboxState(db: Db): State {
  const last = Number(db.meta(LAST_VISIT));
  const snoozes = new Map<string, number>();
  for (const r of db.all<{ key: string; value: string }>(
    "SELECT key, value FROM meta WHERE key LIKE 'inbox:snooze:%'",
  )) {
    const until = Number(r.value);
    if (Number.isFinite(until)) snoozes.set(r.key.slice(SNOOZE.length), until);
  }
  return { lastVisit: db.meta(LAST_VISIT) !== null && Number.isFinite(last) ? last : null, snoozes };
}

/** UI-264: the page's data (`GET /api/inbox`). */
export async function inbox(src: UiSources): Promise<InboxPage> {
  const s = await snapshot(src);
  const state = inboxState(src.db);
  const found: Candidate[] = [];
  const stamp = (key: string, since: number | null) => {
    const wake = state.snoozes.get(key) ?? null;
    const active = wake !== null && wake > s.now;
    // A wait newer than the last visit, or a snooze that ran out after it, is new (UI-264).
    const fresh =
      state.lastVisit !== null &&
      ((since !== null && since > state.lastVisit) || (wake !== null && !active && wake > state.lastVisit));
    return { new: fresh, snoozedUntil: active ? wake : null };
  };
  for (const w of waitsOf(src, s)) {
    // UI-105: the owner already acted from the page; the wait only lingers until the loop moves on.
    if (w.card.done) continue;
    const since = w.card.since?.at ?? null;
    found.push({
      key: w.card.intent,
      rank: 0,
      priority: w.priority,
      since: since ?? Number.POSITIVE_INFINITY,
      item: {
        key: w.card.intent,
        kind: "card",
        repo: w.card.repo,
        title: w.card.title,
        kindLabel: w.card.kindLabel,
        since,
        overview: overviewOf(w.intent),
        history: w.mission ? historyOf(w.mission) : [],
        card: w.card,
        proposed: null,
        cap: null,
        pr: w.card.pr?.number ?? null,
        prUrl: w.card.pr?.url ?? null,
        merge: w.card.actions.includes("merge") && w.card.mergeLabel !== null,
        ...stamp(w.card.intent, since),
      },
    });
  }
  // UI-254: a reached cap needs the owner, and comes before everything it holds back.
  for (const c of capCards(src.db, src.config, s)) {
    const key = `cap-${safe(c.key)}`;
    found.push({
      key,
      rank: 0,
      priority: Number.POSITIVE_INFINITY,
      since: Number.POSITIVE_INFINITY,
      item: {
        key,
        kind: "cap",
        repo: c.scope === "all" ? "" : c.scope,
        title: c.title,
        kindLabel: "Budget",
        since: null,
        overview: null,
        history: [],
        card: null,
        proposed: null,
        cap: c,
        pr: null,
        prUrl: null,
        merge: false,
        ...stamp(key, null),
      },
    });
  }
  // AUT-23: an intent written by a viewer or an unknown account waits for a maintainer to confirm it.
  const held = src.unconfirmed?.() ?? new Map<string, string>();
  for (const i of s.listing?.open ?? []) {
    const reason = held.get(i.id);
    if (reason === undefined) continue;
    const writer = writerOf(src.db, i.id)?.login ?? "";
    found.push({
      key: i.id,
      rank: 0,
      priority: 0,
      since: Number.POSITIVE_INFINITY,
      item: {
        key: i.id,
        kind: "confirm",
        repo: i.repo,
        title: i.title,
        kindLabel: "Confirm",
        since: null,
        overview: overviewOf(i),
        history: [],
        card: null,
        proposed: null,
        cap: null,
        confirm: { reason, writer },
        pr: null,
        prUrl: null,
        merge: false,
        ...stamp(i.id, null),
      },
    });
  }
  const section = proposedSection(src);
  for (const c of section.cards) {
    const key = `proposed-${c.pr}`;
    found.push({
      key,
      rank: c.priority === null || c.parked ? 1 : 0,
      priority: c.priority ?? 0,
      since: c.waitingSince,
      item: {
        key,
        kind: "proposed",
        repo: c.repo,
        title: c.title,
        kindLabel: "Proposed",
        since: c.waitingSince,
        overview: null,
        history: [],
        card: null,
        proposed: c,
        cap: null,
        pr: c.pr,
        prUrl: c.prUrl,
        merge: false,
        ...stamp(key, c.waitingSince),
      },
    });
  }
  const items = found.sort(byInbox).map((c) => c.item);
  if (src.running)
    dropEndedSnoozes(
      src.db,
      items.map((i) => i.key),
    );
  const body = {
    items,
    needs: needCounts(src, s).total,
    lastVisit: state.lastVisit,
    readOnly: !src.running,
    stale: section.stale,
  };
  return { version: versionOf(body, `${dbMark(src.db)}:${s.listing?.head ?? ""}`), ...body };
}

/**
 * UI-264: `seen`, `snooze` and `unsnooze`. They write only the owner's own marks, so no mission moves; a
 * refusal is an `Error` whose message is the reason (UI-67).
 */
export async function inboxAction(
  src: UiSources,
  action: string,
  item: string,
  until: unknown,
): Promise<string> {
  const now = src.clock.now();
  if (action === "seen") {
    // The server's own clock sets the visit; snoozes that ran out are now seen, so they go.
    src.db.tx(() => {
      src.db.setMeta(LAST_VISIT, String(now));
      for (const [k, wake] of inboxState(src.db).snoozes) if (wake <= now) src.db.delMeta(SNOOZE + k);
    });
    return "Saved.";
  }
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(item)) throw new Error("Which item?");
  if (action === "unsnooze") {
    src.db.delMeta(SNOOZE + item);
    return "Back in the list.";
  }
  if (typeof until !== "number" || !Number.isFinite(until)) throw new Error("Until when?");
  if (until <= now) throw new Error("That time has already passed.");
  if (until > now + MAX_SNOOZE_SECS) throw new Error("A snooze can last 30 days at most.");
  if (!(await inbox(src)).items.some((i) => i.key === item))
    throw new Error("That isn't waiting on you now.");
  src.db.setMeta(SNOOZE + item, String(until));
  return "Snoozed.";
}

/** UI-264: a snooze whose wait has ended is dropped. */
export function dropEndedSnoozes(db: Db, waiting: string[]): void {
  for (const k of inboxState(db).snoozes.keys()) if (!waiting.includes(k)) db.delMeta(SNOOZE + k);
}
