// Helpers: existing test files with no test cases may get new exports without asking (PIP-137). A
// file with a test case stays blocked (REPO-13); any other change to a helper is held for the owner.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { Ctx } from "../../src/handlers.ts";
import { dataOf, insertMission, type Mission, update } from "../../src/mission.ts";
import { blockedTests } from "../../src/pipeline/access.ts";
import { askForTests, resolveTestAsk } from "../../src/pipeline/build.ts";
import {
  existingChanged,
  existingTests,
  guardDecision,
  HELPER_WHY,
  heldHelpers,
  helperTests,
  isFreeHelperDiff,
  publishRefusals,
} from "../../src/pipeline/guard.ts";
import { DEFAULT_TESTS } from "../../src/repo/files.ts";
import { Protected } from "../../src/repo/protected.ts";
import { ID, intent, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";
import { FakeTools } from "../helpers/tools.ts";
import { git, tempDir } from "../helpers/world.ts";

const HELPER = "tests/helpers/flows.ts";
const SUITE = "tests/machine.test.ts";

const BASE: Record<string, string> = {
  [HELPER]: [
    'import { join } from "node:path";',
    "",
    "export function path(...p: string[]): string {",
    "  return join(...p);",
    "}",
    "",
  ].join("\n"),
  [SUITE]: 'import { it } from "vitest";\n\nit("works", () => {});\n',
  "tests/helpers/describes.ts":
    'export const label = "x";\n// describe("a note")\ndescribe("x", () => {});\n',
  "tests/__snapshots__/a.snap": "exports[`a`] = `1`;\n",
  "src/main.ts": "export const m = 1;\n",
};

/** A repo whose `main` holds `files`, with `refs/remotes/origin/main` at it (Towercab's checkout). */
function repoWith(dir: string, files: Record<string, string>): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  put(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  return dir;
}

function put(repo: string, files: Record<string, string>): void {
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(join(repo, p, ".."), { recursive: true });
    writeFileSync(join(repo, p), t);
  }
}

const tools = new FakeTools();
const held = (repo: string) => heldHelpers(tools, repo, "main", [HELPER]);
const append = (repo: string, text: string) =>
  put(repo, { [HELPER]: readFileSync(join(repo, HELPER), "utf8") + text });

test("guard: a helper without test cases is not blocked", async () => {
  const repo = repoWith(join(tempDir(), "co"), BASE);
  const existing = await existingTests(tools, repo, "main", DEFAULT_TESTS, null);
  expect(existing).toContain(HELPER);
  // Only code files with no test case are helpers; a snapshot is not one.
  expect(await helperTests(tools, repo, "main", existing)).toEqual([HELPER]);
  const blocked = blockedTests(existing, {}).filter((p) => p !== HELPER);
  const rules = { checkout: repo, protected: [], granted: [], locked: [], existing: blocked };
  expect(guardDecision(rules, { file_path: join(repo, HELPER) })).toEqual({ block: false });
  expect(guardDecision(rules, { file_path: join(repo, SUITE) }).block).toBe(true);
  expect(guardDecision(rules, { file_path: join(repo, "tests/__snapshots__/a.snap") }).block).toBe(true);
});

test("repo: a file with test cases stays blocked", async () => {
  const repo = repoWith(join(tempDir(), "co"), {
    ...BASE,
    "tests/helpers/one.ts": 'export const x = 1;\n\ntest("a", () => {});\n',
    "tests/helpers/two.ts": "export const y = 1;\n\ndescribe.each([1])('b', () => {});\n",
    "tests/helpers/three.ts": "export const z = 1;\n\nit.only(`c`, () => {});\n",
    "tests/helpers/four.ts": "export const w = 1;\n\nbeforeEach(() => {});\n",
  });
  const existing = await existingTests(tools, repo, "main", DEFAULT_TESTS, null);
  const helpers = await helperTests(tools, repo, "main", existing);
  for (const p of ["tests/helpers/one.ts", "tests/helpers/two.ts", "tests/helpers/three.ts", SUITE]) {
    expect(helpers, p).not.toContain(p);
    expect(blockedTests(existing, {}), p).toContain(p);
  }
  // A hook alone is not a test case: that file is a helper (its hook is held, not blocked).
  expect(helpers).toContain(HELPER);
  expect(helpers).toContain("tests/helpers/four.ts");
});

test("pipeline: adding an exported function to a helper does not ask", async () => {
  const repo = repoWith(join(tempDir(), "co"), BASE);
  append(
    repo,
    [
      'import type { Mission } from "../../src/mission.ts";',
      "",
      "/** A mission with a name. */",
      "export function named(m: Mission): string {",
      "  return m.slug;",
      "}",
      "",
      "export type Pair = [string, string];",
      "export interface Named {",
      "  name: string;",
      "}",
      "export const LIMIT = 3;",
      "",
    ].join("\n"),
  );
  expect(await held(repo)).toEqual([]);
  // The same, committed on the branch, passes publish as well.
  git(repo, "checkout", "-q", "-b", "towercab/x");
  git(repo, "commit", "-q", "-am", "build");
  expect(await held(repo)).toEqual([]);
});

test("pipeline: changing a helper function asks", async () => {
  const repo = repoWith(join(tempDir(), "co"), BASE);
  put(repo, { [HELPER]: BASE[HELPER]!.replace("join(...p)", 'join("/", ...p)') });
  expect(await held(repo)).toEqual([HELPER]);
  // A line added inside an existing function is an edit of it.
  put(repo, { [HELPER]: BASE[HELPER]!.replace("  return join(...p);", "  log();\n  return join(...p);") });
  expect(await held(repo)).toEqual([HELPER]);
  // A deleted helper, too.
  git(repo, "checkout", "-q", "--", HELPER);
  git(repo, "rm", "-q", HELPER);
  expect(await held(repo)).toEqual([HELPER]);
});

test("pipeline: a new top-level statement in a helper asks", async () => {
  for (const extra of [
    'vi.mock("node:fs");',
    "beforeEach(() => {});",
    "afterAll(() => {});",
    'console.log("on import");',
    'import "./setup.ts";',
    "const hidden = 1;",
    "export default 1;",
    "export function ok() {\n  vi.mock('x');\n}",
  ]) {
    const repo = repoWith(join(tempDir(), "co"), BASE);
    append(repo, `\nexport const fine = 1;\n${extra}\n`);
    expect(await held(repo), extra).toEqual([HELPER]);
  }
  expect(isFreeHelperDiff("")).toBe(true);
  expect(isFreeHelperDiff("@@ -1,0 +2,1 @@\n+export const a = 1;\n")).toBe(true);
  expect(isFreeHelperDiff("@@ -1,0 +2,1 @@\n+  indented();\n")).toBe(false);
  expect(isFreeHelperDiff("@@ -1,1 +1,1 @@\n-a\n+export const a = 1;\n")).toBe(false);
});

let p: Pipe;
let cx: Ctx;

beforeAll(async () => {
  p = new Pipe(TARGET, { [`intents/${ID}-show-a-greeting/intent.md`]: intent({ a: 5 }) }, { keep: true });
  await p.start({ intents: { remote: "https://github.com/owner/intents.git", cutoff: 1 } });
  cx = p.loop.ctx();
}, 30_000);

afterAll(() => p?.cleanup());

let n = 0;
/** A mission whose checkout is a repo holding `BASE` with a held edit of the helper. */
function missionWithHeldEdit(data: Record<string, unknown>): { m: Mission; checkout: string } {
  const row = p.db.tx(() =>
    insertMission(p.db, { intent: ID, slug: `h${n++}`, repo: "web", model: "opus", a: 5 }, p.clock.now()),
  );
  p.db.run("UPDATE missions SET stage = 'stopped' WHERE id = ?", row.id);
  const m = update(p.db, row.id, { data: JSON.stringify(data) }, p.clock.now());
  const checkout = cx.checkout(m);
  repoWith(checkout, BASE);
  put(checkout, { [HELPER]: BASE[HELPER]!.replace("join(...p)", 'join("/", ...p)') });
  return { m, checkout };
}

test("pipeline: a held helper edit stays until the owner answers", async () => {
  const { m, checkout } = missionWithHeldEdit({});
  const edit = readFileSync(join(checkout, HELPER), "utf8");
  const found = await heldHelpers(cx.tools, checkout, "main", [HELPER]);
  expect(found).toEqual([HELPER]);
  // It joins the one question, with the reason; the edit itself is still in the checkout.
  const o = await askForTests(cx, m, [{ path: HELPER, why: HELPER_WHY }], [HELPER], "", undefined, []);
  expect(o).toMatchObject({ event: "wait", data: { testAsk: { path: HELPER, why: HELPER_WHY, rest: [] } } });
  expect(readFileSync(join(checkout, HELPER), "utf8")).toBe(edit);
  // On allow it stays, and is granted to the owner's account.
  const allowed = { ...dataOf(m), ...(o!.data as object), answer: "Yes" };
  const m2 = update(p.db, m.id, { data: JSON.stringify(allowed) }, p.clock.now());
  const r = await resolveTestAsk(cx, m2);
  expect(dataOf((r as { m: Mission }).m).testAllowed).toEqual([{ path: HELPER, why: HELPER_WHY }]);
  expect(readFileSync(join(checkout, HELPER), "utf8")).toBe(edit);
});

test("pipeline: a refused helper edit is restored", async () => {
  const { m, checkout } = missionWithHeldEdit({
    testAsk: { path: HELPER, why: HELPER_WHY, rest: [] },
    answer: "No, keep all as they are",
  });
  expect(readFileSync(join(checkout, HELPER), "utf8")).not.toBe(BASE[HELPER]);
  const r = await resolveTestAsk(cx, m);
  expect(dataOf((r as { m: Mission }).m).refusedTests).toEqual([{ path: HELPER, why: HELPER_WHY }]);
  expect(readFileSync(join(checkout, HELPER), "utf8")).toBe(BASE[HELPER]);
});

/** What publish makes of the branch, as `publish.ts` does it. */
async function refusals(repo: string, refused: string[] = []): Promise<string[]> {
  const onBase = await existingTests(tools, repo, "main", DEFAULT_TESTS, null);
  const blocked = blockedTests(onBase, {});
  const helpers = (await helperTests(tools, repo, "main", onBase)).filter((x) => !refused.includes(x));
  return publishRefusals(
    [],
    new Protected([], []),
    [],
    [],
    await existingChanged(
      tools,
      repo,
      "main",
      blocked.filter((x) => !helpers.includes(x)),
    ),
    await heldHelpers(
      tools,
      repo,
      "main",
      blocked.filter((x) => helpers.includes(x)),
    ),
  );
}

test("pipeline: publish refuses an unanswered helper change", async () => {
  const repo = repoWith(join(tempDir(), "co"), BASE);
  git(repo, "checkout", "-q", "-b", "towercab/x");
  put(repo, { [HELPER]: BASE[HELPER]!.replace("join(...p)", 'join("/", ...p)') });
  git(repo, "commit", "-q", "-am", "build");
  expect(await refusals(repo)).toEqual([`${HELPER} (an existing helper)`]);
  // A refused helper may have no change at all, not even an addition.
  git(repo, "checkout", "-q", "main");
  git(repo, "checkout", "-q", "-b", "towercab/y");
  append(repo, "export const more = 1;\n");
  git(repo, "commit", "-q", "-am", "build");
  expect(await refusals(repo)).toEqual([]);
  expect(await refusals(repo, [HELPER])).toEqual([`${HELPER} (an existing test)`]);
  // A test with cases is refused as before, even by an addition.
  put(repo, { [SUITE]: `${BASE[SUITE]}it("more", () => {});\n` });
  git(repo, "commit", "-q", "-am", "more");
  expect(await refusals(repo)).toEqual([`${SUITE} (an existing test)`]);
});

test("pipeline: publish passes a free helper change", async () => {
  const repo = repoWith(join(tempDir(), "co"), BASE);
  git(repo, "checkout", "-q", "-b", "towercab/x");
  append(repo, "\nexport async function later(): Promise<number> {\n  return 1;\n}\n");
  put(repo, { "tests/new.test.ts": 'it("new", () => {});\n', "src/main.ts": "export const m = 2;\n" });
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "build");
  expect(await refusals(repo)).toEqual([]);
  // A merge of the base that brought a helper change in is not the worker's change.
  git(repo, "checkout", "-q", "main");
  put(repo, { [HELPER]: BASE[HELPER]!.replace("join(...p)", 'join("/", ...p)') });
  git(repo, "commit", "-q", "-am", "main changes the helper");
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(repo, "checkout", "-q", "towercab/x");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-edit", "main");
  expect(await refusals(repo)).toEqual([]);
});
