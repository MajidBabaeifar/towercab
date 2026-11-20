// The observer's records (OBV-12): each run with its cost and outcome, and the proposals it opened.
// Runs and proposals are kept 90 days; the proposals of the last 7 days are what OBV-7 counts.

import type { Db } from "../db.ts";
import { dayStart } from "../shadow/store.ts";

export const DAY_S = 86_400;
export const WEEK_S = 7 * DAY_S;
const KEEP_S = 90 * DAY_S;

export type RunOutcome = "running" | "done" | "failed" | "capped";

export interface ObserverRun {
  id: number;
  trigger: string;
  started: number;
  ended: number | null;
  cost: number;
  outcome: RunOutcome;
  findings: number;
  proposals: number;
  comments: number;
  /** JSON `{title, why}[]`: findings that were dropped, with the reason. */
  dropped: string;
  /** JSON `{held: {title}[], seen: {title, links}[]}` for the weekly report (OBV-8). */
  detail: string;
}

export interface ProposalRow {
  pr: number;
  intent: string;
  run: number;
  at: number;
  title: string;
  /** JSON `string[]`: the ids it cited. */
  evidence: string;
}

export function startRun(db: Db, trigger: string, now: number): number {
  db.run("INSERT INTO observer_runs (trigger, started) VALUES (?, ?)", trigger, now);
  return Number(db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id);
}

export interface Finished {
  ended: number;
  cost: number;
  outcome: RunOutcome;
  findings: number;
  proposals: number;
  comments: number;
  dropped: { title: string; why: string }[];
  detail: { held: { title: string }[]; seen: { title: string; links: string[] }[]; why?: string };
}

export function finishRun(db: Db, id: number, f: Finished): void {
  db.run(
    `UPDATE observer_runs SET ended = ?, cost = ?, outcome = ?, findings = ?, proposals = ?, comments = ?,
     dropped = ?, detail = ? WHERE id = ?`,
    f.ended,
    f.cost,
    f.outcome,
    f.findings,
    f.proposals,
    f.comments,
    JSON.stringify(f.dropped),
    JSON.stringify(f.detail),
    id,
  );
}

export function getRun(db: Db, id: number): ObserverRun | undefined {
  return db.get<ObserverRun>("SELECT * FROM observer_runs WHERE id = ?", id);
}

export function lastRun(db: Db): ObserverRun | undefined {
  return db.get<ObserverRun>("SELECT * FROM observer_runs ORDER BY id DESC LIMIT 1");
}

/** Runs from `since` on, newest first. */
export function runsSince(db: Db, since: number): ObserverRun[] {
  return db.all<ObserverRun>("SELECT * FROM observer_runs WHERE started >= ? ORDER BY id DESC", since);
}

/** A run left `running` by a crash or a restart is over: it failed. */
export function failStale(db: Db, now: number): number {
  const rows = db.all<{ id: number }>("SELECT id FROM observer_runs WHERE outcome = 'running'");
  for (const r of rows)
    db.run(
      "UPDATE observer_runs SET outcome = 'failed', ended = ?, detail = ? WHERE id = ?",
      now,
      JSON.stringify({ held: [], seen: [], why: "interrupted by a restart" }),
      r.id,
    );
  return rows.length;
}

/** The runs' costs, `{at, cost}`, from `since` on (OBV-10): they join the spend. */
export function observerCosts(db: Db, since: number): { at: number; cost: number }[] {
  return db.all<{ at: number; cost: number }>(
    "SELECT started AS at, cost FROM observer_runs WHERE cost > 0 AND started >= ?",
    since,
  );
}

/** Today's observer cost. */
export function costToday(db: Db, now: number): number {
  return observerCosts(db, dayStart(now)).reduce((n, r) => n + r.cost, 0);
}

export function recordProposal(db: Db, p: ProposalRow): void {
  db.run(
    "INSERT OR IGNORE INTO observer_proposals (pr, intent, run, at, title, evidence) VALUES (?, ?, ?, ?, ?, ?)",
    p.pr,
    p.intent,
    p.run,
    p.at,
    p.title,
    p.evidence,
  );
}

/** Proposals from `since` on, closed ones included (OBV-7). */
export function proposalsSince(db: Db, since: number): ProposalRow[] {
  return db.all<ProposalRow>("SELECT * FROM observer_proposals WHERE at >= ? ORDER BY at DESC", since);
}

export function prune(db: Db, now: number): void {
  db.run("DELETE FROM observer_runs WHERE started < ?", now - KEEP_S);
  db.run("DELETE FROM observer_proposals WHERE at < ?", now - KEEP_S);
}

export function metaList(db: Db, key: string): string[] {
  try {
    const v = JSON.parse(db.meta(key) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
