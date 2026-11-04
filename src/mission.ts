// A mission: one attempt at one intent (LOOP-3, LOOP-37's `missions` row).

import { randomUUID } from "node:crypto";
import type { Db, SqlValue } from "./db.ts";
import type { Stage } from "./machine.ts";

export interface Mission {
  id: number;
  intent: string;
  repo: string;
  attempt: number;
  stage: Stage;
  step: string;
  from_stage: Stage | null;
  waiting: string | null;
  why: string | null;
  continued: number;
  busy: number;
  unclean: number;
  held: number;
  model: string;
  a_at_pick: number | null;
  session: string;
  session_used: number;
  checkout: string;
  branch: string;
  base_sha: string | null;
  head: string | null;
  spec_pr: number | null;
  plan_pr: number | null;
  pr: number | null;
  pushed_at: number | null;
  feedback_seen: string | null;
  merged_by: string | null;
  merge_sha: string | null;
  repairs: number;
  ci_repairs: number;
  retries: number;
  retry_at: number | null;
  limit_model: string | null;
  step_secs: number;
  child_pid: number | null;
  child_kind: string | null;
  child_since: number | null;
  child_model: string | null;
  cost_usd: number;
  agent_secs: number;
  data: string;
  created: number;
  updated: number;
  finished: number | null;
}

/** Columns a handler may set through `Outcome.set` or `ctx.record` (not id, intent, stage, data). */
export const COLUMNS = new Set([
  "step",
  "why",
  "busy",
  "held",
  "model",
  "session",
  "session_used",
  "base_sha",
  "head",
  "spec_pr",
  "plan_pr",
  "pr",
  "branch",
  "pushed_at",
  "feedback_seen",
  "merged_by",
  "merge_sha",
  "repairs",
  "ci_repairs",
  "retries",
  "retry_at",
  "limit_model",
  "step_secs",
  "child_pid",
  "child_kind",
  "child_since",
  "child_model",
  "cost_usd",
  "agent_secs",
  "unclean",
]);

export function getMission(db: Db, id: number): Mission | undefined {
  return db.get<Mission>("SELECT * FROM missions WHERE id = ?", id);
}

/** Missions not done or stopped, oldest first. */
export function unfinished(db: Db): Mission[] {
  return db.all<Mission>(
    "SELECT * FROM missions WHERE stage NOT IN ('done','stopped','unverified') ORDER BY id",
  );
}

export function forIntent(db: Db, intent: string): Mission[] {
  return db.all<Mission>("SELECT * FROM missions WHERE intent = ? ORDER BY id", intent);
}

export function unfinishedFor(db: Db, intent: string): Mission | undefined {
  return db.get<Mission>(
    "SELECT * FROM missions WHERE intent = ? AND stage NOT IN ('done','stopped','unverified')",
    intent,
  );
}

/** Update columns of one mission; each must be in COLUMNS (or `data`). Returns the fresh row. */
export function update(db: Db, id: number, set: Record<string, SqlValue>, now: number): Mission {
  const cols = Object.keys(set);
  for (const c of cols) {
    if (!COLUMNS.has(c) && c !== "data") throw new Error(`bug: mission column ${c} can't be set`);
  }
  if (cols.length > 0) {
    db.run(
      `UPDATE missions SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated = ? WHERE id = ?`,
      ...cols.map((c) => set[c]!),
      now,
      id,
    );
  }
  return getMission(db, id)!;
}

/** The pipeline's per-mission state (`missions.data`), read whole. */
export function dataOf<T extends Record<string, unknown> = Record<string, unknown>>(m: Mission): T {
  try {
    return JSON.parse(m.data) as T;
  } catch {
    return {} as T;
  }
}

/** Merge keys into `missions.data` (a key set to undefined is removed). */
export function patchData(db: Db, m: Mission, patch: Record<string, unknown>, now: number): Mission {
  const d: Record<string, unknown> = { ...dataOf(m), ...patch };
  for (const k of Object.keys(d)) if (d[k] === undefined) delete d[k];
  return update(db, m.id, { data: JSON.stringify(d) }, now);
}

export interface NewMission {
  intent: string;
  slug: string;
  repo: string;
  model: string;
  a: number | null;
  /** At least this attempt (a fresh one after `retry`). */
  minAttempt?: number;
}

/** `towercab/<id>-<slug>`, attempt ≥ 2 with `-<attempt>` (LOOP-5). */
export function branchName(id: string, slug: string, attempt: number): string {
  return attempt >= 2 ? `towercab/${id}-${slug}-${attempt}` : `towercab/${id}-${slug}`;
}

/** Insert a mission at `pick` (inside the caller's transaction). */
export function insertMission(db: Db, n: NewMission, now: number): Mission {
  const last = db.get<{ a: number | null }>(
    "SELECT MAX(attempt) AS a FROM missions WHERE intent = ?",
    n.intent,
  );
  const attempt = Math.max((last?.a ?? 0) + 1, n.minAttempt ?? 1);
  const { lastId } = db.run(
    `INSERT INTO missions (intent, repo, attempt, stage, step, model, a_at_pick, session, checkout, branch,
       created, updated) VALUES (?, ?, ?, 'pick', 'enter', ?, ?, ?, ?, ?, ?, ?)`,
    n.intent,
    n.repo,
    attempt,
    n.model,
    n.a,
    randomUUID(),
    `work/${n.intent}-${attempt}`,
    branchName(n.intent, n.slug, attempt),
    now,
    now,
  );
  return getMission(db, lastId)!;
}

/** `<intent>#<attempt>` for logs. */
export function label(m: Mission): string {
  return m.attempt > 1 ? `${m.intent}#${m.attempt}` : m.intent;
}
