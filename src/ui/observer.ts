// The observer on the page (UI-242): `GET /api/observer`, the panel's data.

import { costToday, lastRun, proposalsSince, WEEK_S } from "../observer/store.ts";
import { money, type UiSources, when } from "./state.ts";
import type { ObserverView } from "./view.ts";

/** The last run, this week's proposals against the limit, and today's spend against the cap. */
export function observerView(src: Pick<UiSources, "db" | "config" | "clock">): ObserverView {
  const { db, config } = src;
  const now = src.clock.now();
  const o = config.observer;
  const last = lastRun(db);
  const spent = costToday(db, now);
  let why: string | null = null;
  if (last) {
    try {
      why = (JSON.parse(last.detail) as { why?: string }).why ?? null;
    } catch {
      why = null;
    }
  }
  return {
    enabled: o.enabled,
    lastRun: last
      ? {
          at: when(last.started, now),
          trigger: last.trigger,
          outcome: last.outcome,
          proposals: last.proposals,
          comments: last.comments,
          why,
        }
      : null,
    proposalsThisWeek: proposalsSince(db, now - WEEK_S).length,
    maxPerWeek: o.maxProposalsPerWeek,
    spentToday: money(spent),
    cap: money(o.dailyBudgetUsd),
    spentUsd: spent,
    capUsd: o.dailyBudgetUsd,
    capReached: spent >= o.dailyBudgetUsd,
    lastReport: db.meta("observer.report"),
  };
}
