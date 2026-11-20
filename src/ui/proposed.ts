// Proposed intents on the page (UI-184 to UI-188): the cards, their order and the stale notice.

import type { ProposedPr } from "../github/proposed.ts";
import { isParked, priority } from "../priority.ts";
import { clock, type UiSources } from "./state.ts";
import type { ProposedCard, ProposedSection } from "./view.ts";

/** `12 min`, `5 h`, `3 d`. */
export function duration(secs: number): string {
  const s = Math.max(0, secs);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86_400)} d`;
}

function cardOf(src: UiSources, p: ProposedPr, now: number, stale: string | null): ProposedCard {
  const i = p.intent;
  const prio = i ? priority(i.u, i.i) : null;
  const parked = prio !== null && isParked(prio, src.config.intents.cutoff);
  const problem = p.reason;
  const acceptWhy = !p.acceptable
    ? (problem ?? "It can't be accepted from here.")
    : stale
      ? "Towercab couldn't reach GitHub, so it can't tell if this changed."
      : !src.running
        ? "Towercab isn't running."
        : null;
  return {
    pr: p.number,
    title: i?.title ?? p.title,
    repo: i?.repo ?? "",
    u: i?.u ?? null,
    i: i?.i ?? null,
    a: i?.a ?? null,
    priority: prio,
    priorityText: prio === null ? "" : parked ? "would be parked" : `priority ${prio}`,
    parked,
    from: `from ${p.proposer}`,
    waiting: `waiting ${duration(now - p.createdAt)}`,
    waitingSince: p.createdAt,
    draft: p.draft,
    prUrl: p.url,
    textUrl: p.textUrl,
    head: p.head,
    problem,
    canAccept: acceptWhy === null,
    acceptWhy,
    ...(i?.source === "observer" ? { observer: true } : {}),
    ...(i?.observer ? { observerNote: i.observer } : {}),
  };
}

/** UI-188: priority descending, oldest PR first; parked and unreadable ones last, in the same order. */
export function sortProposed(cards: ProposedCard[]): ProposedCard[] {
  const rank = (c: ProposedCard) => (c.priority === null || c.parked ? 1 : 0);
  return [...cards].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (b.priority ?? 0) - (a.priority ?? 0) ||
      a.waitingSince - b.waitingSince ||
      a.pr - b.pr,
  );
}

/** Every proposed intent, sorted, with the notice of a failed read. */
export function proposedSection(src: UiSources): ProposedSection {
  const st = src.proposed?.();
  if (!st) return { cards: [], stale: null };
  const now = src.clock.now();
  const stale =
    st.error !== null
      ? `Couldn't reach GitHub at ${clock(st.failedAt ?? now)}: this list may be out of date.`
      : null;
  return { cards: sortProposed(st.list.map((p) => cardOf(src, p, now, stale))), stale };
}

/** UI-186: the cards of one repo; `repo` "" is the unknown-repo group (UI-187). */
export function proposedFor(section: ProposedSection, src: UiSources, repo: string): ProposedSection {
  return {
    stale: section.stale,
    cards: section.cards.filter((c) => (src.config.repos.has(c.repo) ? c.repo : "") === repo),
  };
}
