// Spend per repo (UI-137), kept as a metric: today, the last 7 days and all time, and the totals.
// Today and 7 days come from the runs' costs (MET-29), all time from the missions' totals (MET-28).

import type { Db } from "../db.ts";
import { shadowCosts } from "../shadow/store.ts";
import { localDate, money, type UiSources } from "./state.ts";
import type { RepoSpendView } from "./view.ts";

const DAY = 86_400;

export interface RepoSpend {
  today: number;
  week: number;
  all: number;
}

/** MET-29's window: the last 7 local days, today included (the board's Done column uses it too). */
export function lastSevenDays(now: number): Set<string> {
  const t = new Date(now * 1000);
  const out = new Set<string>();
  for (let i = 0; i < 7; i++) {
    out.add(localDate(new Date(t.getFullYear(), t.getMonth(), t.getDate() - i, 12).getTime() / 1000));
  }
  return out;
}

/**
 * UI-137: what each repo cost today, in the last 7 days and in all time, in the order repos first had a
 * mission. A repo that never cost anything is absent.
 */
export function spendByRepo(db: Db, now: number): Map<string, RepoSpend> {
  const out = new Map<string, RepoSpend>();
  const of = (repo: string) => {
    let s = out.get(repo);
    if (!s) {
      s = { today: 0, week: 0, all: 0 };
      out.set(repo, s);
    }
    return s;
  };
  for (const r of db.all<{ repo: string; total: number }>(
    "SELECT repo, SUM(cost_usd) AS total FROM missions GROUP BY repo HAVING SUM(cost_usd) > 0 ORDER BY MIN(id)",
  )) {
    of(r.repo).all = r.total;
  }
  const week = lastSevenDays(now);
  const today = localDate(now);
  // Runs are kept 30 days; only missions that moved in the window can have runs in it.
  for (const r of db.all<{ repo: string; data: string }>(
    "SELECT repo, data FROM missions WHERE updated >= ? ORDER BY id",
    now - 8 * DAY,
  )) {
    let runs: unknown;
    try {
      runs = (JSON.parse(r.data) as { runs?: unknown }).runs;
    } catch {
      continue;
    }
    if (!Array.isArray(runs)) continue;
    for (const run of runs as { at?: unknown; cost?: unknown; repo?: unknown }[]) {
      if (typeof run?.at !== "number" || typeof run.cost !== "number" || run.at > now) continue;
      const day = localDate(run.at);
      if (!week.has(day)) continue;
      const s = of(r.repo);
      s.week += run.cost;
      if (day === today) s.today += run.cost;
    }
  }
  return out;
}

export interface Periods {
  day: number;
  month: number;
}

/**
 * MET-32: run costs by local day and local month, overall and per repo. A run counts for its mission's repo;
 * the shadow's turns (SHD-18) count overall, and for a repo only when the turn acted on one of its intents.
 */
export function spendPeriods(db: Db, now: number): { all: Periods; repos: Map<string, Periods> } {
  const all: Periods = { day: 0, month: 0 };
  const repos = new Map<string, Periods>();
  const today = localDate(now);
  const month = today.slice(0, 7);
  const add = (p: Periods, at: number, cost: number) => {
    const day = localDate(at);
    if (day.slice(0, 7) !== month || at > now) return;
    p.month += cost;
    if (day === today) p.day += cost;
  };
  const of = (repo: string) => {
    let p = repos.get(repo);
    if (!p) {
      p = { day: 0, month: 0 };
      repos.set(repo, p);
    }
    return p;
  };
  for (const r of db.all<{ repo: string; data: string }>(
    "SELECT repo, data FROM missions WHERE updated >= ? ORDER BY id",
    now - 33 * DAY,
  )) {
    let runs: unknown;
    try {
      runs = (JSON.parse(r.data) as { runs?: unknown }).runs;
    } catch {
      continue;
    }
    if (!Array.isArray(runs)) continue;
    for (const run of runs as { at?: unknown; cost?: unknown; repo?: unknown }[]) {
      if (typeof run?.at !== "number" || typeof run.cost !== "number" || run.at > now) continue;
      add(all, run.at, run.cost);
      // A part of a multi-repo intent (LOOP-78) names its own repo on the run.
      add(of(typeof run.repo === "string" ? run.repo : r.repo), run.at, run.cost);
    }
  }
  // SHD-18: the shadow's turns count overall; for a repo only the turns that acted on its intents.
  const from =
    new Date(new Date(now * 1000).getFullYear(), new Date(now * 1000).getMonth(), 1).getTime() / 1000;
  for (const r of shadowCosts(db, from)) add(all, r.at, r.cost);
  for (const t of db.all<{ id: number; at: number; cost: number }>(
    "SELECT id, at, cost FROM shadow_turns WHERE cost > 0 AND at >= ?",
    from,
  )) {
    for (const a of db.all<{ repo: string }>(
      `SELECT DISTINCT m.repo AS repo FROM shadow_actions a JOIN missions m ON m.intent = a.intent
       WHERE a.turn = ? AND a.outcome = 'done'`,
      t.id,
    )) {
      add(of(a.repo), t.at, t.cost);
    }
  }
  return { all, repos };
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

/** UI-137: one repo's spend, for pages to share. */
export function repoSpend(src: Pick<UiSources, "db" | "clock">, repo: string): RepoSpendView {
  return repoSpendView(spendByRepo(src.db, src.clock.now()).get(repo));
}
