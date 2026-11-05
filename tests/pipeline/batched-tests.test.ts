// The planner predicts the existing tests a change touches (PIP-135), and the build asks about the
// guarded ones once, all together (PIP-136).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { Ctx } from "../../src/handlers.ts";
import { dataOf, insertMission, type Mission, update } from "../../src/mission.ts";
import { parseAccess, renderAccess } from "../../src/pipeline/access.ts";
import { askForTests, resolveTestAsk } from "../../src/pipeline/build.ts";
import { ASK_TEST, existingTests, guardDecision } from "../../src/pipeline/guard.ts";
import { DEFAULT_TESTS } from "../../src/repo/files.ts";
import { ID, intent, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";
import { FakeTools } from "../helpers/tools.ts";
import { git, tempDir } from "../helpers/world.ts";

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
    insertMission(p.db, { intent: ID, slug: `b${n++}`, repo: "web", model: "opus", a: 5 }, p.clock.now()),
  );
  p.db.run("UPDATE missions SET stage = 'stopped' WHERE id = ?", m.id);
  return update(p.db, m.id, { data: JSON.stringify(data) }, p.clock.now());
}

const read = (rel: string) => readFileSync(join(import.meta.dirname, "..", "..", rel), "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");

const A = { path: "tests/a.test.ts", why: "the greeting changed" };
const B = { path: "tests/b.test.ts", why: "renamed export" };
const C = { path: "tests/c.test.ts", why: "new field" };

test("pipeline: plan prompt tells the planner to predict covering tests", () => {
  const text = flat(read("agents/plan.md"));
  expect(text).toContain("for every file the plan changes, find the existing tests that cover it");
  expect(text).toContain("those that import it or share its name");
  expect(text).toContain("`src/machine.ts` → `tests/machine.test.ts`");
  expect(text).toContain("the shared helpers");
  expect(text).toContain("List each one the build will edit, delete or rename in `access.tests`");
  expect(text.indexOf("Predict these before you write `## Access`")).toBeGreaterThan(-1);
});

test("pipeline: plan access lists tests that import a changed file", async () => {
  // The plan changes src/machine.ts; the test that imports it is existing, so the plan's Access lists it.
  const repo = join(tempDir(), "co");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "tests"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "src/machine.ts"), "export const m = 1;\n");
  writeFileSync(join(repo, "tests/machine.test.ts"), 'import { m } from "../src/machine.ts";\n');
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  const existing = await existingTests(new FakeTools(), repo, "main", DEFAULT_TESTS, null);
  const covering = {
    path: "tests/machine.test.ts",
    why: "it imports src/machine.ts, whose transitions change",
  };
  expect(existing).toContain(covering.path);
  const md = renderAccess({ domains: [], paths: [], tests: [covering] }, 5);
  expect(md).toContain(`- [x] test: ${covering.path} (${covering.why})`);
  expect(parseAccess(md).tests).toEqual([covering]);
});

test("pipeline: a build needing three guarded tests asks once with all three", async () => {
  const m = make({});
  const o = await askForTests(cx, m, [A, B, C], [A.path, B.path, C.path], "", undefined, []);
  expect(o).toMatchObject({ event: "wait", data: { testAsk: { path: A.path, rest: [B, C] } } });
  const q = (o!.data as { question: { context: string; question: string; options: { option: string }[] } })
    .question;
  for (const t of [A, B, C]) {
    expect(q.context).toContain(`\`${t.path}\`: ${t.why}`);
  }
  expect(q.question).toBe("May the worker change these 3 tests?");
  expect(q.options.map((x) => x.option)).toEqual(["Allow all of them", "No, keep all as they are"]);
  // One answer settles all three.
  const answered = make({ ...(o!.data as object), answer: "Allow all of them" });
  const r = await resolveTestAsk(cx, answered);
  expect("m" in r).toBe(true);
  expect(dataOf((r as { m: Mission }).m).testAllowed).toEqual([A, B, C]);
});

test("pipeline: a reply can allow some of the asked tests", async () => {
  const m = make({ testAsk: { ...A, rest: [B, C] }, answer: `Yes, ${A.path} only` });
  const r = await resolveTestAsk(cx, m);
  expect("done" in r).toBe(true);
  const o = (r as { done: { event: string; data?: Record<string, unknown> } }).done;
  expect(o.event).toBe("wait");
  // The named file is allowed; the others stay asked, in a question of their own.
  expect(o.data).toMatchObject({ testAllowed: [A], testAsk: { path: B.path, rest: [C] } });
  expect(o.data).not.toHaveProperty("refusedTests");
  const refuse = make({ testAsk: { ...A, rest: [B, C] }, answer: `No, keep ${B.path}` });
  const r2 = await resolveTestAsk(cx, refuse);
  const o2 = (r2 as { done: { data?: Record<string, unknown> } }).done;
  expect(o2.data).toMatchObject({ refusedTests: [B], testAsk: { path: A.path, rest: [C] } });
});

test("pipeline: the guard reason tells the worker to collect every guarded test", () => {
  expect(flat(ASK_TEST)).toContain("carry on with everything that doesn't need it");
  expect(flat(ASK_TEST)).toContain("note every guarded test you need and why");
  expect(flat(ASK_TEST)).toContain("return one status access listing them all");
  const checkout = tempDir();
  const d = guardDecision(
    { checkout, protected: [], granted: [], locked: [], existing: [A.path] },
    { file_path: join(checkout, A.path) },
  );
  expect(d.block && d.reason).toBe(`${A.path} is an existing test: ${ASK_TEST}`);
  const worker = flat(read("agents/worker.md"));
  expect(worker).toContain("don't stop: carry on with everything that doesn't need it");
  expect(worker).toContain('return one `status: "access"` with every file in `access.tests`');
});
