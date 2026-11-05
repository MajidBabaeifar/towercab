// Focus (UI-192 to UI-196): the one wait that needs the owner most, with its context, and how many more
// there are. It reads the waits the needs-you cards show and the proposed intents; it has no data or
// action of its own.

import { proposedSection } from "./proposed.ts";
import { dbMark, historyOf, overviewOf, snapshot, type UiSources, versionOf, waitsOf } from "./state.ts";
import type { FocusItem, FocusPage } from "./view.ts";

/** One thing that could be shown, with what the ranking needs. */
export interface Candidate {
  key: string;
  /** 1 for a proposed intent that would be parked or can't be read: after every other wait. */
  rank: number;
  priority: number;
  /** When the wait began (unix s); infinite when unknown. */
  since: number;
  item: FocusItem;
}

/** UI-193: highest priority first, then the oldest wait, then the key, so the pick never flips. */
export function byFocus(a: Candidate, b: Candidate): number {
  return (
    a.rank - b.rank ||
    b.priority - a.priority ||
    (a.since === b.since ? 0 : a.since < b.since ? -1 : 1) ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
}

/**
 * The Focus page's data (`GET /api/focus`). `skip` names waits the owner has just acted on from the page
 * (UI-195): they are left out of the pick and the count until they stop waiting.
 */
export async function focus(src: UiSources, skip: string[] = []): Promise<FocusPage> {
  const s = await snapshot(src);
  const found: Candidate[] = [];
  for (const w of waitsOf(src, s)) {
    // UI-105: the owner already acted from the page; the wait only lingers until the loop moves on.
    if (w.card.done) continue;
    found.push({
      key: w.card.intent,
      rank: 0,
      priority: w.priority,
      since: w.card.since?.at ?? Number.POSITIVE_INFINITY,
      item: {
        key: w.card.intent,
        repo: w.card.repo,
        title: w.card.title,
        overview: overviewOf(w.intent),
        history: w.mission ? historyOf(w.mission) : [],
        card: w.card,
        proposed: null,
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
      item: { key, repo: c.repo, title: c.title, overview: null, history: [], card: null, proposed: c },
    });
  }
  const asked = [...new Set(skip)];
  const skipped = asked.filter((k) => found.some((c) => c.key === k));
  const left = found.filter((c) => !asked.includes(c.key)).sort(byFocus);
  const item = left[0]?.item ?? null;
  const body = {
    item,
    more: Math.max(0, left.length - 1),
    asked,
    skipped,
    readOnly: !src.running,
    stale: section.stale,
  };
  return { version: versionOf(body, `${dbMark(src.db)}:${s.listing?.head ?? ""}`), ...body };
}
