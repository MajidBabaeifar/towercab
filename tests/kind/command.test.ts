// UI-283: the page's `kind` command writes the kind into the intent and moves a mission that has not passed its stage.

import { expect, test } from "vitest";
import { applyCommand } from "../../src/commands.ts";
import { Db } from "../../src/db.ts";

test("kind: a kind that is not one of the five is refused", async () => {
  const db = Db.memory();
  const { lastId } = db.run(
    "INSERT INTO commands (name, arg, text, source, created) VALUES ('kind', 'x', 'huge', 'ui', 1)",
  );
  const row = db.get<never>("SELECT * FROM commands WHERE id = ?", lastId)!;
  const result = await applyCommand({ db, now: new Date(1000) } as never, row);
  expect(result).toContain('"huge" is not a kind');
});
