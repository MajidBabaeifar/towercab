// The database (LOOP-37): one SQLite file, five tables and a key-value meta.

import { existsSync, renameSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export type SqlValue = SQLInputValue;
export type Row = Record<string, SqlValue>;

/** The repos Towercab works on (LOOP-65); `env` is a JSON object, `path` '' = `<home>/repos/<name>`. */
const REPOS = `CREATE TABLE repos (name TEXT PRIMARY KEY, github TEXT NOT NULL, path TEXT NOT NULL DEFAULT '',
  base TEXT NOT NULL, workers INTEGER NOT NULL DEFAULT 1, ahead INTEGER NOT NULL DEFAULT 3,
  env TEXT NOT NULL DEFAULT '{}', source TEXT NOT NULL, added REAL NOT NULL,
  teammate_review INTEGER NOT NULL DEFAULT 0, reviewers TEXT NOT NULL DEFAULT '');`;

/** The `repos` table as migration 3 made it, before LOOP-83's columns. */
const REPOS_V3 = REPOS.replace(
  ",\n  teammate_review INTEGER NOT NULL DEFAULT 0, reviewers TEXT NOT NULL DEFAULT '');",
  ");",
);

/** SHD-15, SHD-19: the shadow's conversation and the log of what it did. */
const SHADOW = `CREATE TABLE shadow_turns (id INTEGER PRIMARY KEY, update_id INTEGER UNIQUE, at REAL NOT NULL,
  role TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'done', cost REAL NOT NULL DEFAULT 0,
  folded INTEGER NOT NULL DEFAULT 0);
CREATE TABLE shadow_actions (id INTEGER PRIMARY KEY, at REAL NOT NULL, turn INTEGER, idx INTEGER NOT NULL DEFAULT 0,
  action TEXT NOT NULL, intent TEXT NOT NULL DEFAULT '', pr INTEGER NOT NULL DEFAULT 0, outcome TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '', UNIQUE (turn, idx));`;

/** LOOP-128: what the outbox keeps of a Telegram message, to edit it later; added by migration 8. */
const OUTBOX_TG = `,
  kind TEXT NOT NULL DEFAULT 'info', intent TEXT, wait TEXT, tg_message_id INTEGER, target TEXT, buttons TEXT,
  ended_at REAL`;

/** LOOP-126: the owner's Telegram updates, stored once before the offset moves past them. */
const TELEGRAM = `CREATE TABLE telegram_updates (update_id INTEGER PRIMARY KEY, at REAL NOT NULL, data TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'new');`;

/** TG-16: the one Telegram card of a mission (an attempt at an intent), its ping and what was last shown. */
const CARDS = `CREATE TABLE tg_cards (mission INTEGER PRIMARY KEY, intent TEXT NOT NULL, message_id INTEGER,
  text TEXT NOT NULL DEFAULT '', buttons TEXT, ping_id INTEGER, ping_wait TEXT,
  final INTEGER NOT NULL DEFAULT 0, tries INTEGER NOT NULL DEFAULT 0, next_try REAL NOT NULL DEFAULT 0);`;

/** OBV-12: each observer run, and the proposals it opened (kept 90 days). */
const OBSERVER = `CREATE TABLE observer_runs (id INTEGER PRIMARY KEY, trigger TEXT NOT NULL, started REAL NOT NULL,
  ended REAL, cost REAL NOT NULL DEFAULT 0, outcome TEXT NOT NULL DEFAULT 'running',
  findings INTEGER NOT NULL DEFAULT 0, proposals INTEGER NOT NULL DEFAULT 0, comments INTEGER NOT NULL DEFAULT 0,
  dropped TEXT NOT NULL DEFAULT '[]', detail TEXT NOT NULL DEFAULT '{}');
CREATE TABLE observer_proposals (pr INTEGER PRIMARY KEY, intent TEXT NOT NULL, run INTEGER NOT NULL, at REAL NOT NULL,
  title TEXT NOT NULL DEFAULT '', evidence TEXT NOT NULL DEFAULT '[]');`;

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
CREATE UNIQUE INDEX missions_one_per_intent ON missions(intent) WHERE stage NOT IN ('done','stopped','unverified');
CREATE TABLE transitions (id INTEGER PRIMARY KEY, mission INTEGER NOT NULL REFERENCES missions(id),
  at REAL NOT NULL, from_stage TEXT NOT NULL, event TEXT NOT NULL, to_stage TEXT NOT NULL, why TEXT);
CREATE TABLE commands (id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (name IN ('answer','retry','drop','pause','resume','start','done','steps','score','boost','kind')),
  arg TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', source TEXT NOT NULL,
  created REAL NOT NULL, applied_at REAL, result TEXT);
CREATE TABLE outbox (key TEXT PRIMARY KEY, mission INTEGER, text TEXT NOT NULL, created REAL NOT NULL,
  sent_at REAL, tries INTEGER NOT NULL DEFAULT 0, next_try REAL NOT NULL DEFAULT 0${OUTBOX_TG});
${REPOS}
${SHADOW}
${TELEGRAM}
${CARDS}
${OBSERVER}`;

/** Migration i takes `user_version` from i to i+1. Later changes append. */
export const MIGRATIONS: string[] = [
  SCHEMA.replace("'resume','start','done','steps'", "'resume'")
    .replace(OUTBOX_TG, "")
    .replace(`\n${REPOS}\n${SHADOW}\n${TELEGRAM}\n${CARDS}\n${OBSERVER}`, ""),
  // 2: `start` joins the commands (LOOP-63); the CHECK can't be altered, so the table is rebuilt.
  `CREATE TABLE commands_new (id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (name IN ('answer','retry','drop','pause','resume','start')),
  arg TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', source TEXT NOT NULL,
  created REAL NOT NULL, applied_at REAL, result TEXT);
INSERT INTO commands_new SELECT id, name, arg, text, source, created, applied_at, result FROM commands;
DROP TABLE commands;
ALTER TABLE commands_new RENAME TO commands;`,
  // 3: repos move from config.toml into the database (LOOP-65). `IF NOT EXISTS`: after a manual
  // rollback to version 2 (LOOP-37) the table and its rows are still there.
  REPOS_V3.replace("CREATE TABLE repos", "CREATE TABLE IF NOT EXISTS repos"),
  // 4: a mission that ended `unverified` (LOOP-73) is finished, so its intent may start a new one.
  `DROP INDEX missions_one_per_intent;
CREATE UNIQUE INDEX missions_one_per_intent ON missions(intent) WHERE stage NOT IN ('done','stopped','unverified');`,
  // 5: `done` and `steps` join the commands (LOOP-76); the CHECK can't be altered, so the table is rebuilt.
  `CREATE TABLE commands_new (id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (name IN ('answer','retry','drop','pause','resume','start','done','steps')),
  arg TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', source TEXT NOT NULL,
  created REAL NOT NULL, applied_at REAL, result TEXT);
INSERT INTO commands_new SELECT id, name, arg, text, source, created, applied_at, result FROM commands;
DROP TABLE commands;
ALTER TABLE commands_new RENAME TO commands;`,
  // 6: a repo can need a teammate's review (LOOP-83). Additive.
  `ALTER TABLE repos ADD COLUMN teammate_review INTEGER NOT NULL DEFAULT 0;
ALTER TABLE repos ADD COLUMN reviewers TEXT NOT NULL DEFAULT '';`,
  // 7: the shadow's turns and actions (SHD-15, SHD-19). Additive; `IF NOT EXISTS` for a re-upgrade after a manual rollback.
  SHADOW.replaceAll("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS "),
  // 8: the outbox remembers Telegram messages so they can be edited, and the owner's updates are stored (LOOP-126, LOOP-128).
  `ALTER TABLE outbox ADD COLUMN kind TEXT NOT NULL DEFAULT 'info';
ALTER TABLE outbox ADD COLUMN intent TEXT;
ALTER TABLE outbox ADD COLUMN wait TEXT;
ALTER TABLE outbox ADD COLUMN tg_message_id INTEGER;
ALTER TABLE outbox ADD COLUMN target TEXT;
ALTER TABLE outbox ADD COLUMN buttons TEXT;
ALTER TABLE outbox ADD COLUMN ended_at REAL;
${TELEGRAM.replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ")}`,
  // 9: one Telegram card per mission (TG-16). Additive; `IF NOT EXISTS` for a re-upgrade after a manual rollback.
  CARDS.replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS "),
  // 10: `score` and `boost` join the commands (LOOP-134, LOOP-135); the CHECK can't be altered, so the table is rebuilt.
  `CREATE TABLE commands_new (id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (name IN ('answer','retry','drop','pause','resume','start','done','steps','score','boost')),
  arg TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', source TEXT NOT NULL,
  created REAL NOT NULL, applied_at REAL, result TEXT);
INSERT INTO commands_new SELECT id, name, arg, text, source, created, applied_at, result FROM commands;
DROP TABLE commands;
ALTER TABLE commands_new RENAME TO commands;`,
  // 11: the observer's runs and proposals (OBV-12). Additive; `IF NOT EXISTS` for a re-upgrade after a manual rollback.
  OBSERVER.replaceAll("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS "),
  // 12: `kind` joins the commands (UI-283); the CHECK can't be altered, so the table is rebuilt.
  `CREATE TABLE commands_new (id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (name IN ('answer','retry','drop','pause','resume','start','done','steps','score','boost','kind')),
  arg TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', source TEXT NOT NULL,
  created REAL NOT NULL, applied_at REAL, result TEXT);
INSERT INTO commands_new SELECT id, name, arg, text, source, created, applied_at, result FROM commands;
DROP TABLE commands;
ALTER TABLE commands_new RENAME TO commands;`,
];

/**
 * Versions reached by migrations that only add (tables, columns, keys older code doesn't read): a
 * Towercab older than them can still use the database (LOOP-37).
 */
export const ADDITIVE = new Set([3, 6, 7, 8, 9, 10, 11, 12]);
// 10 only widens the CHECK on `commands` (same columns): older code reads the table as before, and a
// `score` or `boost` row it doesn't know just gets an error result, so a rollback stays safe. 12 is the same for `kind`.

/** The oldest Towercab (by its migration count) that can open a database at `version`. */
export function compatibleFrom(version: number): number {
  let from = 0;
  for (let v = 1; v <= version; v++) if (!ADDITIVE.has(v)) from = v;
  return from;
}

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

  /**
   * Open the home's database; a v1 (Rust) one at the same path (it has `repo_caps`) is moved aside to
   * `towercab.v1.db` first and left unused (LOOP-37).
   */
  static openHome(path: string): Db {
    if (existsSync(path)) {
      const probe = new DatabaseSync(path);
      const v1 = probe.prepare("SELECT 1 FROM sqlite_master WHERE name = 'repo_caps'").get() !== undefined;
      probe.close();
      if (v1) {
        const aside = path.replace(/\.db$/, ".v1.db");
        for (const ext of ["", "-wal", "-shm"])
          if (existsSync(path + ext)) renameSync(path + ext, aside + ext);
      }
    }
    return new Db(path);
  }

  static memory(): Db {
    return new Db(":memory:");
  }

  version(): number {
    return Number((this.sql.prepare("PRAGMA user_version").get() as Row).user_version);
  }

  /**
   * Run the migrations this database hasn't had. A newer database opens as it is when it records
   * (`meta.compatible_from`) that this Towercab is new enough: the newer migrations only added things.
   */
  private migrate(): void {
    const v = this.version();
    if (v > MIGRATIONS.length) {
      const from = Number(this.meta("compatible_from") ?? Number.NaN);
      if (Number.isInteger(from) && from <= MIGRATIONS.length) return;
      throw new Error(`towercab.db is version ${v}, newer than this Towercab (${MIGRATIONS.length})`);
    }
    for (let i = v; i < MIGRATIONS.length; i++) {
      this.tx(() => {
        // Migrations 6 and 8 add columns: after a manual rollback (LOOP-37) they are still there.
        const there =
          (i === 5 && this.hasColumn("repos", "teammate_review")) ||
          (i === 7 && this.hasColumn("outbox", "ended_at"));
        if (!there) this.sql.exec(MIGRATIONS[i]!);
        this.sql.exec(`PRAGMA user_version = ${i + 1}`);
        this.setMeta("compatible_from", String(compatibleFrom(i + 1)));
      });
    }
  }

  private hasColumn(table: string, column: string): boolean {
    return this.sql
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .some((r) => (r as Row).name === column);
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
