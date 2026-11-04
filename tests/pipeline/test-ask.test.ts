// The build stage's question about an existing test (PIP-116), driven through the handler functions on a
// prepared mission, and the sandbox's deny list at scale (REPO-13).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type ClaudeRun, claudeSettings } from "../../src/claude.ts";
import type { Ctx } from "../../src/handlers.ts";
import { dataOf, insertMission, type Mission, update } from "../../src/mission.ts";
import { askForTests, resolveTestAsk } from "../../src/pipeline/build.ts";
import { ID, intent, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";
import { tempDir, testConfig } from "../helpers/world.ts";

let p: Pipe;
let cx: Ctx;

beforeAll(async () => {
  p = new Pipe(TARGET, { [`intents/${ID}-show-a-greeting/intent.md`]: intent({ a: 5 }) }, { keep: true });
  await p.start({ intents: { remote: "https://github.com/owner/intents.git", cutoff: 1 } });
  cx = p.loop.ctx();
}, 30_000);

afterAll(() => p.cleanup());

let n = 0;
function make(data: Record<string, unknown>): Mission {
  const m = p.db.tx(() =>
    insertMission(p.db, { intent: ID, slug: `t${n++}`, repo: "web", model: "opus", a: 5 }, p.clock.now()),
  );
  p.db.run("UPDATE missions SET stage = 'stopped' WHERE id = ?", m.id);
  return update(p.db, m.id, { data: JSON.stringify(data) }, p.clock.now());
}

const ASKED = { path: "tests/a.test.ts", why: "the greeting changed" };

test("pipeline: a test question clears an earlier answer", async () => {
  // The owner answered something else earlier; asking about a test must not keep that answer.
  const m = make({ answer: "Yes, use v2" });
  const lines: string[] = [];
  const o = await askForTests(cx, m, [ASKED], [ASKED.path], "", undefined, lines);
  expect(o).toMatchObject({ event: "wait", data: { testAsk: { path: ASKED.path, rest: [] } } });
  expect(o!.data).toHaveProperty("answer", undefined);
  expect((o!.data as { question: { question: string } }).question.question).toBe(
    "May the worker change `tests/a.test.ts`?",
  );
});

test("pipeline: an earlier yes does not grant a test", async () => {
  // The data the mission holds once the question is out: the old answer is gone, and the owner edited
  // the intent file, which brings no text.
  const m0 = make({ answer: "Yes, use v2" });
  const o = (await askForTests(cx, m0, [ASKED], [ASKED.path], "", undefined, []))!;
  const kept = { ...dataOf(m0), ...o.data } as Record<string, unknown>;
  const m = make(JSON.parse(JSON.stringify(kept)));
  expect(dataOf(m).answer).toBeUndefined();
  const r = await resolveTestAsk(cx, m);
  expect("m" in r).toBe(true);
  const d = dataOf((r as { m: Mission }).m);
  expect(d.testAllowed).toBeUndefined();
  expect(d.refusedTests).toEqual([ASKED]);
  expect(d.testAsk).toBeUndefined();
  expect(String(d.testNote)).toContain("refused");
});

test("pipeline: the owner's reply to the test question allows it and the worker resumes with the grant", async () => {
  const m = make({ testAsk: { ...ASKED, rest: [] }, answer: "Allow this change" });
  const r = await resolveTestAsk(cx, m);
  const d = dataOf((r as { m: Mission }).m);
  expect(d.testAllowed).toEqual([ASKED]);
  expect(d.refusedTests).toBeUndefined();
  expect(String(d.testNote)).toContain("allowed you to change tests/a.test.ts");
});

test("pipeline: several tests are asked one after the other", async () => {
  const second = { path: "tests/b.test.ts", why: "renamed" };
  const m = make({ testAsk: { ...ASKED, rest: [second] }, answer: "Allow this change" });
  const r = await resolveTestAsk(cx, m);
  expect("done" in r).toBe(true);
  const o = (r as { done: { event: string; data?: Record<string, unknown> } }).done;
  expect(o.event).toBe("wait");
  expect(o.data).toMatchObject({ testAsk: { path: second.path, rest: [] }, testAllowed: [ASKED] });
  expect(o.data).toHaveProperty("answer", undefined);
});

test("claude: thousands of existing tests are all denied for writing", () => {
  const checkout = join(tempDir(), "c");
  mkdirSync(join(checkout, "tests"), { recursive: true });
  const existing: string[] = [];
  for (let i = 0; i < 2000; i++) {
    existing.push(`tests/t${i}.test.ts`);
    writeFileSync(join(checkout, `tests/t${i}.test.ts`), "x");
  }
  const run: ClaudeRun = {
    kind: "worker",
    model: "opus",
    cwd: checkout,
    runsDir: join(tempDir(), "runs"),
    n: 1,
    prompt: "do it",
    session: { mode: "none", id: "" },
    claudeMd: "",
    grants: { domains: [], paths: [], open: false },
    cacheEnv: {},
    config: testConfig({ agent: { path: "/usr/bin:/bin" } }, "/cfg/config.toml"),
    guardRules: { checkout, protected: [], granted: [], locked: [], existing },
  };
  const t0 = Date.now();
  const s = claudeSettings(run, { towercabExe: "/x/towercab", home: "/home/me" }) as {
    sandbox: { filesystem: { denyWrite: string[] } };
  };
  const deny = s.sandbox.filesystem.denyWrite;
  expect(Date.now() - t0).toBeLessThan(2000);
  for (const rel of existing) expect(deny, rel).toContain(join(checkout, rel));
  expect(new Set(deny).size).toBe(deny.length);
});
