import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Db, MIGRATIONS, SCHEMA } from "../src/db.ts";
import { tempDir } from "./helpers/world.ts";

test("db: schema matches the spec", () => {
  const spec = readFileSync("specs/loop.md", "utf8");
  const block = spec.slice(spec.lastIndexOf("**Schema**")).split("```sql\n")[1]!.split("```")[0]!;
  expect(SCHEMA.trim()).toBe(block.trim());
  const db = Db.memory();
  const tables = db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  );
  expect(tables.map((t) => t.name)).toEqual(["commands", "meta", "missions", "outbox", "transitions"]);
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
  again.close();
  expect(() => new Db(path)).toThrow(/newer than this Towercab/);
});
