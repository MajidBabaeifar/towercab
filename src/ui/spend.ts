// Spend per repo (UI-137), kept as a metric: today, the last 7 days and all time, and the totals.
// Today and 7 days come from the runs' costs (MET-29), all time from the missions' totals (MET-28).

import type { Db } from "../db.ts";
import { localDate, money, type UiSources } from "./state.ts";
import type { RepoSpendView } from "./view.ts";

const DAY = 86_400;

export interface RepoSpend {
  today: number;
  week: number;
  all: number;
}

/** MET-29's window: the last 7 local days, today included. */
function weekDays(now: number): Set<string> {
  const t = new Date(now * 1000);
  const out = new Set<string>();
  for (let i = 0; i < 7; i++) {
    out.add(localDate(new Date(t.getFullYear(), t.getMonth(), t.getDate() - i, 12).getTime() / 1000));
  }
  return out;
}

/** UI-137: what each repo cost today, in the last 7 days and in all time. */
export function spendByRepo(db: Db, now: number): Map<string, RepoSpend> {
  const out = new Map<string, RepoSpend>();
  const week = weekDays(now);
  const today = localDate(now);
  for (const r of db.all<{ repo: string; cost_usd: number; data: string; updated: number }>(
    "SELECT repo, cost_usd, data, updated FROM missions ORDER BY id",
  )) {
    let s = out.get(r.repo);
    if (!s) {
      s = { today: 0, week: 0, all: 0 };
      out.set(r.repo, s);
    }
    s.all += r.cost_usd;
    // Runs are kept 30 days; only missions that moved in the window can have runs in it.
    if (r.updated < now - 8 * DAY) continue;
    let runs: unknown;
    try {
      runs = (JSON.parse(r.data) as { runs?: unknown }).runs;
    } catch {
      continue;
    }
    if (!Array.isArray(runs)) continue;
    for (const run of runs as { at?: unknown; cost?: unknown }[]) {
      if (typeof run?.at !== "number" || typeof run.cost !== "number" || run.at > now) continue;
      const day = localDate(run.at);
      if (week.has(day)) s.week += run.cost;
      if (day === today) s.today += run.cost;
    }
  }
  return out;
}

/** The sums over every repo. */
export function spendTotals(by: Map<string, RepoSpend>): RepoSpend {
  const t = { today: 0, week: 0, all: 0 };
  for (const s of by.values()) {
    t.today += s.today;
    t.week += s.week;
    t.all += s.all;
  }
  return t;
}

export function repoSpendView(s: RepoSpend | undefined): RepoSpendView {
  const v = s ?? { today: 0, week: 0, all: 0 };
  return {
    today: money(v.today),
    week: money(v.week),
    all: money(v.all),
    todayUsd: v.today,
    weekUsd: v.week,
    allUsd: v.all,
  };
}

/** UI-137: one repo's spend, for any page that shows a repo. */
export function repoSpend(src: Pick<UiSources, "db" | "clock">, repo: string): RepoSpendView {
  return repoSpendView(spendByRepo(src.db, src.clock.now()).get(repo));
}
