import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { compatibleFrom, Db, MIGRATIONS, SCHEMA } from "../src/db.ts";
import { tempDir } from "./helpers/world.ts";

test("db: schema matches the spec", () => {
  const spec = readFileSync("specs/loop.md", "utf8");
  const block = spec.slice(spec.lastIndexOf("**Schema**")).split("```sql\n")[1]!.split("```")[0]!;
  expect(SCHEMA.trim()).toBe(block.trim());
  const db = Db.memory();
  const tables = db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  );
  expect(tables.map((t) => t.name)).toEqual([
    "commands",
    "link_codes",
    "meta",
    "missions",
    "observer_proposals",
    "observer_runs",
    "outbox",
    "repos",
    "sessions",
    "shadow_actions",
    "shadow_turns",
    "telegram_updates",
    "tg_card_chats",
    "tg_cards",
    "transitions",
    "user_events",
    "users",
  ]);
});

test("db: migrations run in order", () => {
  const path = join(tempDir(), "t.db");
  const db = new Db(path);
  expect(db.version()).toBe(MIGRATIONS.length);
  db.setMeta("k", "v");
  db.close();
  const again = new Db(path);
  expect(again.meta("k")).toBe("v");
  expect(() => again.tx(() => Promise.resolve(1))).toThrow(/async/);
  again.sql.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
  again.setMeta("compatible_from", String(MIGRATIONS.length + 1));
  again.close();
  expect(() => new Db(path)).toThrow(/newer than this Towercab/);
});

test("db: a newer database that only added opens, and rolls back by hand", () => {
  const path = join(tempDir(), "t.db");
  const db = new Db(path);
  // Migration 3 (the repos table) only adds: a Towercab from before it can still use the database.
  expect(compatibleFrom(3)).toBe(2);
  expect(db.meta("compatible_from")).toBe(String(compatibleFrom(MIGRATIONS.length)));
  db.run("INSERT INTO repos (name, github, base, source, added) VALUES ('web', 'o/web', 'main', 'cli', 0)");
  // A later additive migration: this Towercab opens it as it is, without touching it.
  db.sql.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
  db.close();
  const newer = new Db(path);
  expect(newer.version()).toBe(MIGRATIONS.length + 1);
  newer.close();
  // The manual rollback step (LOOP-37): back to version 2; upgrading again keeps the repos.
  const old = new DatabaseSync(path);
  old.exec("PRAGMA user_version = 2");
  old.close();
  const again = new Db(path);
  expect(again.version()).toBe(MIGRATIONS.length);
  expect(again.all("SELECT name FROM repos")).toEqual([{ name: "web" }]);
});

test("db: a v1 database is moved aside", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const path = join(tempDir(), "towercab.db");
  const v1 = new DatabaseSync(path);
  v1.exec("CREATE TABLE repo_caps (repo TEXT); PRAGMA user_version = 5;");
  v1.close();
  const db = Db.openHome(path);
  expect(db.version()).toBe(MIGRATIONS.length);
  expect(readFileSync(path.replace(".db", ".v1.db")).length).toBeGreaterThan(0);
});
