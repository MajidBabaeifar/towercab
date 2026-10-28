// Files another program leaves in a mission's checkout (LOOP-8): a build round drops them first, so
// they neither block the checkout of base nor ride into the PR; ignored files such as caches stay.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { build, CODE, happy, ID, intent, intents, PLAN, SLUG, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";
import { pushFiles } from "../helpers/world.ts";

let p: Pipe;
let cacheKept = false;

beforeAll(async () => {
  p = new Pipe({ ...TARGET, ".gitignore": "cache/\n" }, intents(intent({ a: 5 })), { keep: true });
  happy(p);
  p.respond.plan = (spec) => {
    // While the plan runs, another program writes into the checkout, and base gets the same file.
    writeFileSync(join(spec.cwd, "AGENTS.md"), "written by another program\n");
    writeFileSync(join(spec.cwd, "README.md"), "edited by another program\n");
    mkdirSync(join(spec.cwd, "cache"), { recursive: true });
    writeFileSync(join(spec.cwd, "cache", "keep"), "a cache\n");
    pushFiles(p.bares.web!, { "AGENTS.md": "from main\n" });
    return { structured: PLAN };
  };
  p.respond.worker = (spec) => {
    cacheKept = existsSync(join(spec.cwd, "cache", "keep"));
    return { structured: build(), edits: CODE };
  };
  await p.start();
  await p.untilStage("done");
}, 60_000);

afterAll(() => p.cleanup());

test("pipeline: a build round starts from a clean checkout", () => {
  const m = p.mission()!;
  expect(p.db.all("SELECT why FROM transitions WHERE event = 'crash' AND mission = ?", m.id)).toEqual([]);
  const branch = `towercab/${ID}-${SLUG}`;
  // Base's own files, not the other program's.
  expect(p.show("web", branch, "AGENTS.md")).toBe("from main\n");
  expect(p.show("web", branch, "README.md")).toBe("web\n");
  expect(p.show("web", branch, "greeting.txt")).toBe("hello\n");
  expect(cacheKept).toBe(true);
});
