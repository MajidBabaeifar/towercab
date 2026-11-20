// UI-253..256: the budgets, the cap cards and the top bar's spend, as the page shows them.

import { type Cap, capKey, capReason, capsOf, raiseTo } from "../budgets.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import { spendPeriods } from "./spend.ts";
import { money, type Snap } from "./state.ts";
import type { BudgetsView, CapCard, TopBar } from "./view.ts";

export const BUDGET_WHERE = "Saved in config.toml on this machine.";

/** UI-253: one scope's amounts and what is spent in the period (`all`, or a repo's short name). */
export function budgetsView(db: Db, config: Config, now: number, scope: string): BudgetsView {
  const sp = spendPeriods(db, now);
  const spent = scope === "all" ? sp.all : (sp.repos.get(scope) ?? { day: 0, month: 0 });
  const mine = scope === "all" ? null : config.budgets.repos.get(scope);
  return {
    scope,
    daily: scope === "all" ? config.agent.dailyBudgetUsd : (mine?.dailyUsd ?? null),
    monthly: scope === "all" ? config.budgets.monthlyUsd : (mine?.monthlyUsd ?? null),
    spentDay: money(spent.day),
    spentMonth: money(spent.month),
    spentDayUsd: spent.day,
    spentMonthUsd: spent.month,
    where: BUDGET_WHERE,
  };
}

/** UI-254: one card per reached cap. */
export function capCards(db: Db, config: Config, s: Pick<Snap, "now" | "listing" | "missions">): CapCard[] {
  const started = new Set(s.missions.map((m) => m.intent));
  return capsOf(db, config, s.now).map((c) => cardOf(c, s, started));
}

function cardOf(c: Cap, s: Pick<Snap, "now" | "listing">, started: Set<string>): CapCard {
  const waiting = (s.listing?.open ?? []).filter(
    (i) => (c.scope === "all" || i.repo === c.scope) && !started.has(i.id),
  ).length;
  const per = c.period === "day" ? "Daily" : "Monthly";
  const until = c.period === "day" ? "midnight" : "the 1st";
  const scopeName = c.scope === "all" ? "Towercab" : c.scope;
  return {
    key: capKey(c, s.now),
    scope: c.scope,
    period: c.period,
    title:
      c.scope === "all"
        ? `${per} budget reached: ${money(c.spent)} of ${money(c.cap)}`
        : `${c.scope} reached its ${per.toLowerCase()} cap: ${money(c.spent)} of ${money(c.cap)}`,
    line: `Work for ${scopeName} is paused until ${until}.`,
    reason: capReason(c),
    capUsd: c.cap,
    spentUsd: c.spent,
    raiseTo: raiseTo(c),
    waiting,
  };
}

/** UI-256: the top bar's spend against the budget; amber from 80 %, red from 100 %. */
export function topBudget(config: Config, today: number, month: number): NonNullable<TopBar["budgetChip"]> {
  const daily = config.agent.dailyBudgetUsd;
  const monthly = config.budgets.monthlyUsd;
  const parts = [daily === null ? `${money(today)} today` : `${money(today)} of ${money(daily)}`];
  if (monthly !== null) parts.push(`${money(month)} of ${money(monthly)} this month`);
  const used = Math.max(daily === null ? 0 : today / daily, monthly === null ? 0 : month / monthly);
  const level = used >= 1 ? "red" : used >= 0.8 ? "amber" : "ok";
  return {
    text: parts.join(" · "),
    level,
    note: level === "red" ? "Budget reached" : level === "amber" ? "80% used" : null,
  };
}
