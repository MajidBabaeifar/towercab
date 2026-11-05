import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { Db, MIGRATIONS } from "../src/db.ts";
import { tempDir } from "./helpers/world.ts";

test("db: the commands rebuild keeps existing rows and accepts done and steps", () => {
  const path = join(tempDir(), "t.db");
  // A database from before the rebuild (migrations 0..3 ran), with a command in it.
  const old = new DatabaseSync(path);
  for (let i = 0; i < 5 - 1; i++) old.exec(MIGRATIONS[i]!);
  old.exec(`PRAGMA user_version = ${5 - 1}`);
  old.exec("INSERT INTO commands (name, arg, text, source, created) VALUES ('drop', 'x', 'note', 'cli', 1)");
  old.close();
  const db = new Db(path);
  expect(db.all<{ name: string; arg: string; text: string }>("SELECT name, arg, text FROM commands")).toEqual(
    [{ name: "drop", arg: "x", text: "note" }],
  );
  db.run("INSERT INTO commands (name, source, created) VALUES ('done', 'cli', 2)");
  db.run("INSERT INTO commands (name, source, created) VALUES ('steps', 'cli', 3)");
  expect(() => db.run("INSERT INTO commands (name, source, created) VALUES ('nope', 'cli', 4)")).toThrow();
});
