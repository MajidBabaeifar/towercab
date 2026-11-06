// `towercab answer <id> allow <path>` also unlocks a test the repair lock stopped, for the mission (PIP-152).

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { main } from "../src/cli.ts";
import { Db } from "../src/db.ts";
import { Home } from "../src/home.ts";
import { dataOf, getMission, insertMission } from "../src/mission.ts";
import { blockedTests } from "../src/pipeline/access.ts";
import { lockableTests } from "../src/pipeline/guard.ts";
import { intent } from "./helpers/flows.ts";
import { FakeTools } from "./helpers/tools.ts";
import { bareRepo, tempDir } from "./helpers/world.ts";

const ID = "261026-1000";
const A = "tests/a.test.ts";

function world() {
  const dir = tempDir("tc-allow-locked-");
  const home = join(dir, "home");
  const bare = bareRepo({ [`intents/${ID}-t/intent.md`]: intent({ title: "T" }) });
  const config = join(dir, "config.toml");
  writeFileSync(
    config,
    `[intents]\nremote = "${bare}"\n[github]\napp_id = 1\nme = "owner"\n[repos.web]\ngithub = "owner/web"\n`,
  );
  return { home, args: ["--config", config, "--home", home] };
}

const out: string[] = [];
afterEach(() => vi.restoreAllMocks());

function capture() {
  out.length = 0;
  vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    out.push(String(s));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((s) => {
    out.push(String(s));
    return true;
  });
}

test("cli: answer allow unlocks a test locked in a repair round", async () => {
  const w = world();
  const db = new Db(Home.resolve(w.home).db);
  const m = insertMission(db, { intent: ID, slug: "t", repo: "web", model: "opus", a: 5 }, 1);
  db.run(
    "UPDATE missions SET stage = 'build', step = '', data = ? WHERE id = ?",
    JSON.stringify({ lockedTests: [A, "tests/b.test.ts"] }),
    m.id,
  );
  db.close();
  capture();
  expect(await main([...w.args, "answer", ID, "allow", A], new FakeTools())).toBe(0);
  expect(out.join("")).toContain(`Allowed: \`${A}\``);
  const after = new Db(Home.resolve(w.home).db);
  const d = dataOf<{
    testAllowed?: { path: string; why: string }[];
    lockedTests?: string[];
    testNote?: string;
  }>(getMission(after, m.id)!);
  expect(d.testAllowed?.map((t) => t.path)).toEqual([A]);
  expect(d.lockedTests).toEqual(["tests/b.test.ts"]);
  expect(d.testNote).toContain(`now allows you to change ${A}`);
  // Later rounds see it as granted: neither the lock nor the base-test block holds it.
  expect(blockedTests([A, "tests/b.test.ts"], d)).toEqual(["tests/b.test.ts"]);
  expect(lockableTests([A, "tests/b.test.ts"], [A, "tests/b.test.ts"], d)).toEqual(["tests/b.test.ts"]);
  // A path that is neither refused nor locked still fails, and the error lists the locked ones.
  out.length = 0;
  await main([...w.args, "answer", ID, "allow", "tests/c.test.ts"], new FakeTools());
  expect(out.join("")).toContain(
    "tests/c.test.ts was not refused; no test is refused; locked: tests/b.test.ts",
  );
  after.close();
});
