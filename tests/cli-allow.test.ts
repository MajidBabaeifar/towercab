// `towercab answer <id> allow <path>`: the owner reverses a refusal for the running mission (PIP-141).

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { main } from "../src/cli.ts";
import { Db } from "../src/db.ts";
import { Home } from "../src/home.ts";
import { dataOf, getMission, insertMission } from "../src/mission.ts";
import { blockedTests } from "../src/pipeline/access.ts";
import { intent } from "./helpers/flows.ts";
import { FakeTools } from "./helpers/tools.ts";
import { bareRepo, tempDir } from "./helpers/world.ts";

const ID = "261026-1000";
const A = "tests/a.test.ts";
const B = "tests/b.test.ts";

function world() {
  const dir = tempDir("tc-allow-");
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

/** A mission of the intent with two refused tests, in `stage`. */
function mission(w: ReturnType<typeof world>, stage: string) {
  const db = new Db(Home.resolve(w.home).db);
  const m = insertMission(db, { intent: ID, slug: "t", repo: "web", model: "opus", a: 5 }, 1);
  db.run(
    "UPDATE missions SET stage = ?, step = '', waiting = ?, from_stage = ?, data = ? WHERE id = ?",
    stage,
    stage === "blocked" ? "answer the question" : null,
    stage === "blocked" ? "build" : null,
    JSON.stringify({
      refusedTests: [
        { path: A, why: "a" },
        { path: B, why: "b" },
      ],
      testNote: "The owner refused changes to both.",
    }),
    m.id,
  );
  return { db, id: m.id };
}

test("cli: answer allow moves a refused test to allowed", async () => {
  const w = world();
  const { db, id } = mission(w, "build");
  db.close();
  capture();
  expect(await main([...w.args, "answer", ID, "allow", A], new FakeTools())).toBe(0);
  expect(out.join("")).toContain(`Allowed: \`${A}\``);
  const after = new Db(Home.resolve(w.home).db);
  const m = getMission(after, id)!;
  const d = dataOf<{
    testAllowed?: { path: string; why: string }[];
    refusedTests?: { path: string; why: string }[];
    testNote?: string;
  }>(m);
  // Moved, not copied; the other refusal stands; the mission stays where it was.
  expect(d.testAllowed?.map((t) => t.path)).toEqual([A]);
  expect(d.refusedTests?.map((t) => t.path)).toEqual([B]);
  expect(blockedTests([A, B], d)).toEqual([B]);
  expect(d.testNote).toContain(`now allows you to change ${A}`);
  expect(m.stage).toBe("build");
  after.close();
});

test("cli: answer allow fails for a test that was not refused", async () => {
  const w = world();
  const { db, id } = mission(w, "build");
  db.close();
  capture();
  await main([...w.args, "answer", ID, "allow", "tests/c.test.ts"], new FakeTools());
  expect(out.join("")).toContain(`tests/c.test.ts was not refused; refused: ${A}, ${B}`);
  const after = new Db(Home.resolve(w.home).db);
  expect(dataOf<{ testAllowed?: unknown }>(getMission(after, id)!).testAllowed).toBeUndefined();
  after.close();
});

test("pipeline: a blocked mission continues after a refusal is reversed", async () => {
  const w = world();
  const { db, id } = mission(w, "blocked");
  db.close();
  capture();
  await main([...w.args, "answer", ID, "allow", A, B], new FakeTools());
  const after = new Db(Home.resolve(w.home).db);
  const m = getMission(after, id)!;
  expect(m.stage).toBe("build");
  expect(m.waiting).toBeNull();
  const d = dataOf<{ testAllowed?: { path: string; why: string }[]; refusedTests?: unknown }>(m);
  expect(d.testAllowed?.map((t) => t.path)).toEqual([A, B]);
  expect(d.refusedTests).toBeUndefined();
  after.close();
});
