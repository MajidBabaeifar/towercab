// MET-31, MET-33: the owner's budgets and repo caps, kept in `config.toml`, and which of them are reached.

import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import type { Mission } from "./mission.ts";
import { spendPeriods } from "./ui/spend.ts";
import { localDate } from "./ui/state.ts";

export interface RepoBudget {
  dailyUsd: number | null;
  monthlyUsd: number | null;
}

export interface Budgets {
  monthlyUsd: number | null;
  repos: Map<string, RepoBudget>;
  /** Keys the last read could not use: the reasons, shown as a Problem (MET-31). */
  problems: string[];
}

export function emptyBudgets(): Budgets {
  return { monthlyUsd: null, repos: new Map(), problems: [] };
}

export const BAD_BUDGET = "a budget is a positive amount in USD";
const MAX = 1_000_000;

/** A typed amount: null for "none"; throws `BAD_BUDGET` for anything but a positive amount of at most 2 decimals. */
export function parseAmount(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0 || n > MAX || Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) {
    throw new Error(BAD_BUDGET);
  }
  return n;
}

function amountOf(v: unknown): number | null {
  try {
    return typeof v === "number" ? parseAmount(v) : null;
  } catch {
    return null;
  }
}

function table(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Read the budget keys of a parsed `config.toml` into `config`, in place. A key that is not a positive
 * number is ignored with a problem and the last good value stays.
 */
export function applyBudgets(config: Config, raw: Record<string, unknown>): void {
  const prev = config.budgets;
  const problems: string[] = [];
  const read = (t: Record<string, unknown>, name: string, path: string, old: number | null) => {
    if (!(name in t)) return null;
    const v = amountOf(t[name]);
    if (v === null) {
      problems.push(`${path} must be a positive amount in USD; the last good value stays`);
      return old;
    }
    return v;
  };
  const agent = table(raw.agent);
  config.agent.dailyBudgetUsd = read(
    agent,
    "daily_budget_usd",
    "agent.daily_budget_usd",
    config.agent.dailyBudgetUsd,
  );
  const monthlyUsd = read(agent, "monthly_budget_usd", "agent.monthly_budget_usd", prev.monthlyUsd);
  const repos = new Map<string, RepoBudget>();
  for (const [name, t] of Object.entries(table(raw.budget))) {
    const old = prev.repos.get(name);
    repos.set(name, {
      dailyUsd: read(table(t), "daily_usd", `budget.${name}.daily_usd`, old?.dailyUsd ?? null),
      monthlyUsd: read(table(t), "monthly_usd", `budget.${name}.monthly_usd`, old?.monthlyUsd ?? null),
    });
  }
  config.budgets = { monthlyUsd, repos, problems };
}

/** MET-31: read the file again at the start of a pass, so an edit applies without a restart. */
export function reloadBudgets(config: Config): void {
  let raw: Record<string, unknown>;
  try {
    raw = parseToml(readFileSync(config.file, "utf8")) as Record<string, unknown>;
  } catch {
    return; // a missing or unreadable file keeps what is in force
  }
  applyBudgets(config, raw);
}

/** The header names a table writes `budget.<repo>` as: bare or quoted. */
function headerNames(path: string): string[] {
  const [first, ...rest] = path.split(".");
  if (first !== "budget" || rest.length === 0) return [path];
  const name = rest.join(".");
  return [`budget.${name}`, `budget."${name}"`];
}

/**
 * Set (or with null remove) one key of one table of `config.toml`, touching only that line: the rest of the
 * file stays byte-identical. Refuses, and writes nothing, if the result would not parse.
 */
export function setBudgetKey(file: string, path: string, key: string, value: number | null): void {
  const text = readFileSync(file, "utf8");
  const lines = text.split(/(?<=\n)/);
  const names = headerNames(path);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const header = (l: string) => /^\s*\[/.test(l) && !/^\s*\[\[/.test(l);
  const nameOf = (l: string) => /^\s*\[\s*([^\]]*?)\s*\]/.exec(l)?.[1]?.replace(/\s+/g, "") ?? "";
  const start = lines.findIndex((l) => header(l) && names.includes(nameOf(l)));
  if (start < 0) {
    if (value === null) return;
    const sep = text === "" || text.endsWith("\n") ? "" : eol;
    lines.push(
      `${sep}${text === "" ? "" : eol}[${names[/^[\w-]+$/.test(path.replace(/^budget\./, "")) ? 0 : names.length - 1]!}]${eol}${key} = ${value}${eol}`,
    );
  } else {
    let end = lines.findIndex((l, n) => n > start && /^\s*\[/.test(l));
    if (end < 0) end = lines.length;
    const at = lines.findIndex((l, n) => n > start && n < end && new RegExp(`^\\s*${key}\\s*=`).test(l));
    if (at >= 0) {
      if (value === null) lines.splice(at, 1);
      else {
        const l = lines[at]!;
        const m = /^(\s*[^=]+=\s*)([^#\r\n]*?)(\s*#.*?)?(\r?\n?)$/.exec(l);
        if (m) lines[at] = `${m[1]}${value}${m[3] ?? ""}${m[4]}`;
      }
    } else if (value !== null) {
      let last = end - 1;
      while (last > start && lines[last]!.trim() === "") last--;
      const before = lines[last]!;
      if (!before.endsWith("\n")) lines[last] = `${before}${eol}`;
      lines.splice(last + 1, 0, `${key} = ${value}${eol}`);
    }
  }
  const next = lines.join("");
  if (next === text) return;
  let back: unknown;
  try {
    back = parseToml(next);
  } catch {
    throw new Error("config.toml would no longer parse, so nothing was saved");
  }
  let t: unknown = back;
  for (const part of path.split(".")) t = (t as Record<string, unknown> | undefined)?.[part];
  const got = (t as Record<string, unknown> | undefined)?.[key];
  if ((value === null && got !== undefined) || (value !== null && got !== value)) {
    throw new Error("config.toml would not read back as typed, so nothing was saved");
  }
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, next, { mode: statSync(file).mode & 0o777 });
  renameSync(tmp, file);
}

export interface BudgetChange {
  at: number;
  /** `all`, or the repo's short name. */
  repo: string;
  text: string;
}

/** UI-253: the changes made from the page, newest last (kept in `meta.budget_log`, the last 200). */
export function budgetChanges(db: Db): BudgetChange[] {
  try {
    const v = JSON.parse(db.meta("budget_log") ?? "[]") as unknown;
    return Array.isArray(v) ? (v as BudgetChange[]) : [];
  } catch {
    return [];
  }
}

const fmt = (n: number | null) => (n === null ? "none" : Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);

/**
 * UI-253: write the amounts typed for one scope (`all`, or a repo) to `config.toml`, apply them now and
 * record each change as old → new. Resolves with the sentence the page shows.
 */
export function saveBudgets(
  d: { db: Db; config: Config; clock: { now(): number } },
  scope: string,
  daily: unknown,
  monthly: unknown,
): string {
  const repo = scope === "all" ? null : scope;
  if (repo !== null && !d.config.repos.has(repo))
    throw new Error(`Towercab doesn't know a repo named ${repo}.`);
  const b = repo === null ? null : d.config.budgets.repos.get(repo);
  const old = {
    daily: repo === null ? d.config.agent.dailyBudgetUsd : (b?.dailyUsd ?? null),
    monthly: repo === null ? d.config.budgets.monthlyUsd : (b?.monthlyUsd ?? null),
  };
  // Absent leaves the amount as it is; null (or empty) removes the limit.
  const next = {
    daily: daily === undefined ? old.daily : parseAmount(daily),
    monthly: monthly === undefined ? old.monthly : parseAmount(monthly),
  };
  const log: BudgetChange[] = [];
  for (const period of ["daily", "monthly"] as const) {
    if (next[period] === old[period]) continue;
    const [path, key] =
      repo === null
        ? (["agent", `${period}_budget_usd`] as const)
        : ([`budget.${repo}`, `${period}_usd`] as const);
    setBudgetKey(d.config.file, path, key, next[period]);
    const what = repo === null ? `${period} budget` : `${repo} ${period} cap`;
    log.push({ at: d.clock.now(), repo: scope, text: `${what}: ${fmt(old[period])} → ${fmt(next[period])}` });
  }
  if (log.length === 0) return "Nothing changed.";
  reloadBudgets(d.config);
  d.db.setMeta("budget_log", JSON.stringify([...budgetChanges(d.db), ...log].slice(-200)));
  return "Saved. Applies now.";
}

export interface Cap {
  /** `all`, or a repo's short name. */
  scope: string;
  period: "day" | "month";
  spent: number;
  cap: number;
}

/** MET-33: the budgets and caps whose spend has reached the amount (reached = spend ≥ the amount). */
export function capsOf(db: Db, config: Config, now: number): Cap[] {
  const { daily, monthly } = limitsOf(config);
  if (daily === null && monthly === null && config.budgets.repos.size === 0) return [];
  const sp = spendPeriods(db, now);
  const out: Cap[] = [];
  const check = (scope: string, period: Cap["period"], spent: number, cap: number | null) => {
    if (cap !== null && spent >= cap) out.push({ scope, period, spent, cap });
  };
  check("all", "day", sp.all.day, daily);
  check("all", "month", sp.all.month, monthly);
  for (const [repo, b] of config.budgets.repos) {
    const s = sp.repos.get(repo) ?? { day: 0, month: 0 };
    check(repo, "day", s.day, b.dailyUsd);
    check(repo, "month", s.month, b.monthlyUsd);
  }
  return out;
}

export function limitsOf(config: Config): { daily: number | null; monthly: number | null } {
  return { daily: config.agent.dailyBudgetUsd, monthly: config.budgets.monthlyUsd };
}

/** The period a cap holds for, as a key: the local date, or the local month. */
export function capKey(c: Cap, now: number): string {
  const day = localDate(now);
  return `${c.scope}:${c.period}:${c.period === "day" ? day : day.slice(0, 7)}`;
}

/** UI-61: why work waits, in a few words. */
export function capReason(c: Cap): string {
  const per = c.period === "day" ? "daily" : "monthly";
  return c.scope === "all" ? `${per} budget reached` : `${c.scope} reached its ${per} cap`;
}

/** UI-254: the amount "Raise to" offers: 10 % of the cap, at least $5, in whole dollars, and above the spend. */
export function raiseTo(c: Cap): number {
  const step = Math.max(5, Math.ceil(c.cap * 0.1));
  return Math.max(c.cap + step, Math.floor(c.spent) + step);
}

/** A mission whose stage needs no Claude run is never held by a cap (merge, the owner's steps). */
export function needsRun(m: Pick<Mission, "stage">): boolean {
  return m.stage !== "merge" && m.stage !== "steps";
}
