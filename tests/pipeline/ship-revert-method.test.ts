// SHIP-12 and LOOP-154: the automatic revert follows how the repo merged.

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Mission } from "../../src/mission.ts";
import { revertArgs } from "../../src/pipeline/ship.ts";
import { build, happy, intent, intents, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";
import { git, tempDir } from "../helpers/world.ts";

const URL = "https://web.example.dev";

const LIVE = `---
live:
  url: ${URL}
  timeout: 5
  suites:
    - name: smoke
      command: sh e2e/smoke.sh
      tests: [e2e/smoke.sh]
      smoke: true
    - name: greet
      command: sh e2e/greet.sh
      tests: [e2e/greet.sh]
      paths: [greeting.txt]
---
`;

const SHIP_TARGET: Record<string, string> = {
  ...TARGET,
  "TOWERCAB.md": LIVE,
  "e2e/smoke.sh": `test "$BASE_URL" = ${URL}\n`,
  "e2e/greet.sh": "true\n",
};

const GREET_E2E = 'grep -q hello greeting.txt || { echo "no hello on the page"; exit 1; }\n';

test("ship: a merge commit is reverted against its first parent", () => {
  expect(revertArgs("abc", 1)).toEqual(["revert", "--no-edit", "abc"]);
  expect(revertArgs("abc", 2)).toEqual(["revert", "--no-edit", "-m", "1", "abc"]);
  // Against a real merge commit: without `-m 1` git refuses, with it the change is undone.
  const dir = tempDir("tc-revert-");
  git(dir, "init", "--quiet", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "base");
  git(dir, "checkout", "--quiet", "-b", "side");
  writeFileSync(join(dir, "b.txt"), "b\n");
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "side");
  git(dir, "checkout", "--quiet", "main");
  git(dir, "merge", "--quiet", "--no-ff", "-m", "merge side", "side");
  const sha = git(dir, "rev-parse", "HEAD").trim();
  const parents = git(dir, "rev-list", "--parents", "-n", "1", sha).trim().split(/\s+/).length - 1;
  expect(parents).toBe(2);
  expect(() => git(dir, "revert", "--no-edit", sha)).toThrow();
  git(dir, "revert", "--no-edit", ...revertArgs(sha, parents).slice(2, -1), sha);
  expect(() => git(dir, "show", "HEAD:b.txt")).toThrow();
});

describe("ship: a rebase repo", () => {
  let p: Pipe;
  let m: Mission;

  beforeAll(async () => {
    p = new Pipe(SHIP_TARGET, intents(intent({ a: 5 })), { keep: true });
    happy(p);
    p.db.run(
      "INSERT INTO repos (name, github, base, source, added, merge_method) VALUES ('web', 'owner/web', 'main', 'cli', 0, 'rebase')",
    );
    const dir = join(p.home.root, "secrets");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "web.env"), "E2E_TOKEN=x\n");
    chmodSync(join(dir, "web.env"), 0o600);
    p.platform = () => ({ state: "success" });
    let round = 0;
    p.respond.worker = () => {
      round++;
      const edits: Record<string, string> = {
        "greeting.txt": `${Array.from({ length: round }, (_, i) => `hullo ${i + 1}`).join("\n")}\n`,
        [`tests/greeting-${round}.sh`]: `grep -q "hullo ${round}" greeting.txt\n`,
      };
      if (round === 1) edits["e2e/greet.sh"] = GREET_E2E;
      return { structured: build(), edits };
    };
    await p.start();
    m = await p.untilStage("blocked", 200);
  }, 180_000);

  afterAll(() => p.cleanup());

  test("ship: a rebase repo is not reverted automatically", () => {
    expect(m.waiting).toBe("rollback failed");
    expect(m.why).toContain("was merged by rebase");
    expect(p.prs.find((x) => x.title === "Revert: Show a greeting")).toBeUndefined();
  });
});
