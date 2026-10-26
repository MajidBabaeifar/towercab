// The database (LOOP-37): one SQLite file, four tables and a key-value meta.

import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export type SqlValue = SQLInputValue;
export type Row = Record<string, SqlValue>;

/** LOOP-37 **Schema**, as written in specs/loop.md (a test compares them). */
export const SCHEMA = `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE missions (
  id INTEGER PRIMARY KEY, intent TEXT NOT NULL, repo TEXT NOT NULL, attempt INTEGER NOT NULL,
  stage TEXT NOT NULL, step TEXT NOT NULL DEFAULT 'enter', from_stage TEXT,
  waiting TEXT, why TEXT, continued INTEGER NOT NULL DEFAULT 0,
  busy INTEGER NOT NULL DEFAULT 0, unclean INTEGER NOT NULL DEFAULT 0, held INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL, a_at_pick INTEGER, session TEXT NOT NULL, session_used INTEGER NOT NULL DEFAULT 0,
  checkout TEXT NOT NULL, branch TEXT NOT NULL, base_sha TEXT, head TEXT,
  spec_pr INTEGER, plan_pr INTEGER, pr INTEGER, pushed_at REAL, feedback_seen TEXT,
  merged_by TEXT, merge_sha TEXT,
  repairs INTEGER NOT NULL DEFAULT 0, ci_repairs INTEGER NOT NULL DEFAULT 0,
  retries INTEGER NOT NULL DEFAULT 0, retry_at REAL, limit_model TEXT, step_secs REAL NOT NULL DEFAULT 0,
  child_pid INTEGER, child_kind TEXT, child_since REAL, child_model TEXT,
  cost_usd REAL NOT NULL DEFAULT 0, agent_secs REAL NOT NULL DEFAULT 0,
  data TEXT NOT NULL DEFAULT '{}', created REAL NOT NULL, updated REAL NOT NULL, finished REAL);
CREATE UNIQUE INDEX missions_one_per_intent ON missions(intent) WHERE stage NOT IN ('done','stopped');
CREATE TABLE transitions (id INTEGER PRIMARY KEY, mission INTEGER NOT NULL REFERENCES missions(id),
  at REAL NOT NULL, from_stage TEXT NOT NULL, event TEXT NOT NULL, to_stage TEXT NOT NULL, why TEXT);
CREATE TABLE commands (id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (name IN ('answer','retry','drop','pause','resume')),
  arg TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', source TEXT NOT NULL,
  created REAL NOT NULL, applied_at REAL, result TEXT);
CREATE TABLE outbox (key TEXT PRIMARY KEY, mission INTEGER, text TEXT NOT NULL, created REAL NOT NULL,
  sent_at REAL, tries INTEGER NOT NULL DEFAULT 0, next_try REAL NOT NULL DEFAULT 0);`;

/** Migration i takes `user_version` from i to i+1. Later changes append. */
export const MIGRATIONS: string[] = [SCHEMA];

export class Db {
  readonly sql: DatabaseSync;
  private depth = 0;

  constructor(path: string) {
    this.sql = new DatabaseSync(path);
    this.sql.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    this.migrate();
  }

  static memory(): Db {
    return new Db(":memory:");
  }

  version(): number {
    return Number((this.sql.prepare("PRAGMA user_version").get() as Row).user_version);
  }

  private migrate(): void {
    const v = this.version();
    if (v > MIGRATIONS.length) {
      throw new Error(`towercab.db is version ${v}, newer than this Towercab (${MIGRATIONS.length})`);
    }
    for (let i = v; i < MIGRATIONS.length; i++) {
      this.tx(() => {
        this.sql.exec(MIGRATIONS[i]!);
        this.sql.exec(`PRAGMA user_version = ${i + 1}`);
      });
    }
  }

  /** One `BEGIN IMMEDIATE` transaction; nested calls join the outer one. `fn` must not be async. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.sql.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const out = fn();
      if (out instanceof Promise) throw new Error("bug: Db.tx got an async function");
      this.sql.exec("COMMIT");
      return out;
    } catch (e) {
      this.sql.exec("ROLLBACK");
      throw e;
    } finally {
      this.depth--;
    }
  }

  all<T = Row>(query: string, ...params: SqlValue[]): T[] {
    return this.sql.prepare(query).all(...params) as T[];
  }

  get<T = Row>(query: string, ...params: SqlValue[]): T | undefined {
    return this.sql.prepare(query).get(...params) as T | undefined;
  }

  run(query: string, ...params: SqlValue[]): { changes: number; lastId: number } {
    const r = this.sql.prepare(query).run(...params);
    return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
  }

  meta(key: string): string | null {
    return this.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.run(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  delMeta(key: string): void {
    this.run("DELETE FROM meta WHERE key = ?", key);
  }

  close(): void {
    this.sql.close();
  }
}
