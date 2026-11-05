// Stage handlers called directly on a prepared mission (PIP-3, PIP-5, PIP-7, PIP-18, PIP-41): the
// decisions made in code, row by row, against a real clone and the fake GitHub.

import { afterAll, beforeAll, expect, test } from "vitest";
import { loadAgent } from "../../src/agents.ts";
import { checksOf } from "../../src/github/checks.ts";
import type { Ctx, Progress } from "../../src/handlers.ts";
import { insertMission, type Mission, update } from "../../src/mission.ts";
import { bucket, type Check, ciHandler } from "../../src/pipeline/ci.ts";
import { ask } from "../../src/pipeline/common.ts";
import { gateHandler } from "../../src/pipeline/gate.ts";
import { approvedOf, reviewComment } from "../../src/pipeline/review.ts";
import { parseResult, type ReviewResult } from "../../src/pipeline/schemas.ts";
import { pickHandler } from "../../src/pipeline/start.ts";
import { defaultReview } from "../../src/repo/files.ts";
import { checkRun, ID, intent, REVIEW, TARGET } from "../helpers/flows.ts";
import { type FakePr, Pipe } from "../helpers/pipe.ts";
import { git } from "../helpers/world.ts";

const NO_A = "261026-1001";

let p: Pipe;
let cx: Ctx;
let pr: FakePr;
let head: string;

beforeAll(async () => {
  p = new Pipe(
    TARGET,
    {
      [`intents/${ID}-show-a-greeting/intent.md`]: intent({ a: 5 }),
      [`intents/${NO_A}-no-level/intent.md`]: intent({ a: null, title: "No level" }),
    },
    { keep: true },
  );
  await p.start({ intents: { remote: "https://github.com/owner/intents.git", cutoff: 1 } });
  cx = p.loop.ctx();
  // One pick makes the clone every handler below reads the repo files from.
  const m = make(ID, 5);
  const r = await pickHandler.step(cx, m);
  expect(r).toMatchObject({ done: { event: "ok" } });
  p.pushTo("web", "main", { "greeting.txt": "hello\n" }, "base moves");
  head = p.headSha("owner/web", "main");
  await p.tools.run(
    "gh",
    ["pr", "create", "-R", "owner/web", "--base", "main", "--head", "main", "--title", "t"],
    {
      input: "worker text",
    },
  );
  pr = p.prs[0]!;
}, 30_000);

afterAll(() => p.cleanup());

let n = 0;
/** A mission row for `intent` at `a_at_pick` with `data` (each a new intent row: the unique index). */
function make(intentId: string, a: number | null, data: Record<string, unknown> = {}, set = {}): Mission {
  const m = p.db.tx(() =>
    insertMission(p.db, { intent: intentId, slug: `s${n++}`, repo: "web", model: "opus", a }, p.clock.now()),
  );
  // Leave the unfinished-mission index free for the next row.
  p.db.run("UPDATE missions SET stage = 'stopped' WHERE id = ?", m.id);
  return update(p.db, m.id, { data: JSON.stringify(data), ...set }, p.clock.now());
}

const review = (o: Partial<{ approved: boolean; door: string; redLines: boolean }> = {}) => ({
  approved: true,
  door: "two-way",
  redLines: false,
  summary: "ok",
  details: "Approve.",
  patchId: "x",
  ...o,
});

/** A kept code risk (AUT-16) at `level`, of the reviewed diff `x`. */
const risk = (level: string, of = "x") => ({
  risk: {
    code: {
      level,
      said: level,
      raised: null,
      blast: { size: "small", who: "Visitors." },
      door: { kind: "two-way", why: "A revert undoes it." },
      certainty: { level: "high", why: "Tested." },
      summary: "Small.",
      openPoints: [],
      of: "x",
    },
  },
  riskOf: { code: of },
});

test("pipeline: gate table", async () => {
  const green = {
    ci: { result: "green" },
    review: review(),
    proof: "proven",
    verify: { result: "green", log: "" },
    ...risk("low"),
  };
  const unplanned = { domains: [{ domain: "x.org", why: "w" }], paths: [] };
  const rows: [string, number | null, Record<string, unknown>, string | null][] = [
    [ID, 5, { ...green, ci: { result: "pending" } }, "GitHub's automatic checks haven't passed."],
    [
      ID,
      5,
      { ...green, review: review({ approved: false }) },
      "The independent code review didn't approve it, even after fix rounds.",
    ],
    [ID, 5, { ...green, review: null }, "The independent code review didn't finish."],
    [ID, 4, { ...green, unplanned }, "The agent needed access the approved plan didn't grant."],
    [ID, 5, { ...green, unplanned }, null],
    [ID, 5, { ...green, unproven: true }, "No test shows that the change works: none fails without it."],
    [ID, 3, { ...green, ci: { result: "none" } }, "At autonomy a3 you merge every change yourself."],
    [ID, 1, green, "At autonomy a1 you merge every change yourself."],
    // No `a` counts as a5 (AUT-9): medium risk goes ahead, high waits (AUT-18).
    [NO_A, null, green, null],
    [NO_A, null, { ...green, ...risk("medium") }, null],
    [
      NO_A,
      null,
      { ...green, ...risk("high") },
      "It is high risk, and at autonomy a5 low- and medium-risk changes go ahead without you.",
    ],
    [NO_A, null, { ...green, unplanned }, null],
    [
      ID,
      4,
      { ...green, ...risk("medium") },
      "It is medium risk, and at autonomy a4 only low-risk changes go ahead without you.",
    ],
    // An assessment of another diff, or none, is no assessment (AUT-19).
    [
      ID,
      5,
      { ...green, ...risk("low", "older") },
      "The risk check didn't finish, so you decide whether it goes ahead.",
    ],
    [
      ID,
      5,
      { ...green, risk: { code: null }, riskOf: { code: "x" } },
      "The risk check didn't finish, so you decide whether it goes ahead.",
    ],
    [ID, 4, { ...green, ci: { result: "none" } }, null],
    [ID, 5, green, null],
  ];
  const got = [];
  for (const [id, a, data, _] of rows) {
    const m = make(id, a, data, { pr: pr.number, head });
    const out = (await gateHandler.step(cx, m)) as Extract<Progress, { done: unknown }>;
    got.push(out.done.event === "wait" ? out.done.why : out.done.event === "ok" ? null : out.done.event);
    if (out.done.event === "ok") expect(out.done.set).toEqual({ head });
    else expect(out.done.waiting).toBe("review and merge PR");
  }
  expect(got).toEqual(rows.map((r) => r[3]));
  // The PR's Checks section is written before the decision.
  expect(pr.body).toContain("## Checks");
  expect(pr.body).toContain("- Review: approved");
  // And its risk, in plain words (PIP-99).
  expect(pr.body).toContain("## Risk: low");
  expect(pr.body).toContain("Easy to undo: A revert undoes it.");
});

test("pipeline: approval is computed in code", () => {
  const r = REVIEW as ReviewResult;
  expect(approvedOf(r)).toBe(true);
  // The reviewer's yes is not enough: every other field must agree.
  expect(approvedOf({ ...r, approved: false })).toBe(false);
  expect(approvedOf({ ...r, outcomes: [{ bullet: "b", met: false, why: "missing" }] })).toBe(false);
  expect(approvedOf({ ...r, tests_weakened: { value: true, where: "tests/a.sh" } })).toBe(false);
  expect(approvedOf({ ...r, plan_followed: { value: false, where: "step 2" } })).toBe(false);
  expect(
    approvedOf({
      ...r,
      findings: [{ severity: "important", pass: "Bugs", file: "a.ts", line: 3, what: "bug" }],
    }),
  ).toBe(false);
  expect(
    approvedOf({
      ...r,
      findings: [{ severity: "nit", pass: "Bugs", file: "a.ts", line: null, what: "name" }],
    }),
  ).toBe(true);
  // Nits are capped by REVIEW.md.
  const nits = Array.from({ length: 8 }, (_, i) => ({
    severity: "nit" as const,
    pass: "Bugs",
    file: `f${i}`,
    line: null,
    what: `n${i}`,
  }));
  const body = reviewComment({ ...r, findings: nits }, { ...defaultReview(), nitCap: 2 });
  expect(body.match(/^- Bugs · `f\d`: n\d$/gm)).toEqual(["- Bugs · `f0`: n0", "- Bugs · `f1`: n1"]);
});

test("pipeline: review findings name their pass", () => {
  const r = REVIEW as ReviewResult;
  const finding = { severity: "important", pass: "Security", file: "a.ts", line: 3, what: "token logged" };
  expect(parseResult("review", { ...r, findings: [finding] }).ok).toBe(true);
  const { pass: _, ...noPass } = finding;
  expect(parseResult("review", { ...r, findings: [noPass] })).toEqual({
    ok: false,
    why: "result.findings[0].pass is missing",
  });
  // A pass outside REVIEW.md's list is kept as written.
  expect(parseResult("review", { ...r, findings: [{ ...finding, pass: "Accessibility" }] }).ok).toBe(true);
  expect(loadAgent("review").prompt).toContain("`pass`");
});

test("pipeline: review comment shows each finding's pass", () => {
  const r = REVIEW as ReviewResult;
  const body = reviewComment(
    {
      ...r,
      findings: [
        { severity: "important", pass: "Security", file: "a.ts", line: 3, what: "token logged" },
        { severity: "nit", pass: "Compliance", file: "b.ts", line: null, what: "row text" },
      ],
    },
    defaultReview(),
  );
  expect(body).toContain("**Needs attention**\n\n- Security · `a.ts:3`: token logged");
  expect(body).toContain("**Smaller things**\n\n- Compliance · `b.ts`: row text");
});

const run = (conclusion: string, o: Partial<Check> = {}): Check => ({
  name: `job-${conclusion}`,
  kind: "run",
  status: "COMPLETED",
  conclusion,
  startedAt: 2000,
  run: 7,
  url: "https://github.com/o/r/actions/runs/7/job/1",
  ...o,
});
const status = (state: string): Check => ({
  name: `ctx-${state}`,
  kind: "status",
  status: state === "PENDING" ? "PENDING" : "COMPLETED",
  conclusion: state,
  startedAt: 2000,
  run: null,
  url: "",
});

test("pipeline: CI buckets", () => {
  const b = (cs: Check[]) => bucket(cs, 1000, 5000, 120).kind;
  for (const c of ["SUCCESS", "NEUTRAL", "SKIPPED"]) expect(b([run(c)])).toBe("green");
  for (const c of ["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"])
    expect(b([run(c)])).toBe("red");
  expect(b([status("FAILURE")])).toBe("red");
  expect(b([status("ERROR")])).toBe("red");
  expect(b([status("SUCCESS"), run("SUCCESS")])).toBe("green");
  expect(b([run("CANCELLED")])).toBe("cancel");
  expect(b([run("", { status: "IN_PROGRESS" })])).toBe("pending");
  expect(b([status("PENDING")])).toBe("pending");
  expect(b([run("SUCCESS"), run("", { status: "QUEUED", run: 8 })])).toBe("pending");
  // A failed job counts once its run has finished; red wins over cancelled.
  expect(b([run("FAILURE"), run("", { status: "IN_PROGRESS" })])).toBe("pending");
  expect(b([run("FAILURE", { run: 7 }), run("CANCELLED", { run: 8 })])).toBe("red");
  // Towercab's own statuses never count.
  expect(b([run("FAILURE", { name: "towercab/verify" }), run("SUCCESS")])).toBe("green");
  // gh's rollup shapes.
  const parsed = checksOf([
    checkRun("test", "FAILURE", 42),
    {
      __typename: "StatusContext",
      context: "ci/legacy",
      state: "PENDING",
      startedAt: "2026-10-26T12:00:00Z",
    },
  ]);
  expect(parsed.map((c) => [c.kind, c.name, c.status, c.conclusion, c.run])).toEqual([
    ["run", "test", "COMPLETED", "FAILURE", 42],
    ["status", "ci/legacy", "PENDING", "PENDING", null],
  ]);
});

/** A mission at `ci` on the fake PR. */
function atCi(set: Record<string, unknown> = {}): Mission {
  return make(ID, 5, {}, { pr: pr.number, head, pushed_at: p.clock.now() - 600, ...set });
}

test("pipeline: no checks counts as green", async () => {
  expect(bucket([], 1000, 1100, 120).kind).toBe("pending");
  expect(bucket([], 1000, 1200, 120).kind).toBe("none");
  pr.checks = () => [];
  const out = await ciHandler.step(cx, atCi());
  expect(out).toEqual({ done: { event: "ok", why: "no CI on this repo", data: { ci: { result: "none" } } } });
});

test("pipeline: stale green is ignored", async () => {
  // Within the grace after a push, a green that started before it is the old head's: pending.
  expect(bucket([run("SUCCESS", { startedAt: 900 })], 1000, 1050, 120).kind).toBe("pending");
  expect(bucket([run("SUCCESS", { startedAt: 1010 })], 1000, 1050, 120).kind).toBe("green");
  // Checks read for another head than the mission's never count: the PR's head is adopted (the
  // checkout moves to it) and polled again.
  const m = make(ID, 5);
  await pickHandler.step(cx, m);
  const co = cx.checkout(m);
  git(co, "commit", "-q", "--allow-empty", "-m", "someone else's commit");
  git(co, "push", "-q", p.bares.web!, `HEAD:refs/heads/${m.branch}`);
  const theirs = git(co, "rev-parse", "HEAD").trim();
  git(co, "reset", "-q", "--hard", "HEAD~1");
  await p.tools.run("gh", [
    "pr",
    "create",
    "-R",
    "owner/web",
    "--base",
    "main",
    "--head",
    m.branch,
    "--title",
    "t",
  ]);
  const pr2 = p.prs.at(-1)!;
  pr2.checks = () => [checkRun("test", "SUCCESS")];
  const stale = update(
    p.db,
    m.id,
    { pr: pr2.number, head: "0".repeat(40), pushed_at: p.clock.now() - 600 },
    p.clock.now(),
  );
  expect(await ciHandler.step(cx, stale)).toEqual({ poll: 5 });
  expect(p.mission(m.id)!.head).toBe(theirs);
  expect(git(co, "rev-parse", "HEAD").trim()).toBe(theirs);
  const again = await ciHandler.step(cx, p.mission(m.id)!);
  expect(again).toMatchObject({ done: { event: "ok", data: { ci: { result: "green" } } } });
});

test("pipeline: red is rerun once", async () => {
  pr.checks = () => [checkRun("test", "FAILURE", 42)];
  const m = atCi();
  const first = await ciHandler.step(cx, m);
  expect(first).toEqual({ poll: 5 });
  expect(p.reruns).toEqual([42]);
  expect(p.tools.lines("gh")).toContain(`run rerun 42 -R owner/web --failed`);
  const m2 = p.mission(m.id)!;
  expect(m2.ci_repairs).toBe(0);
  // The same head red again: now it counts, as a repair round with the failed log.
  const second = (await ciHandler.step(cx, m2)) as Extract<Progress, { done: unknown }>;
  expect(second.done).toMatchObject({ event: "red", set: { ci_repairs: 1 } });
  expect((second.done.data as { repair: { details: string } }).repair.details).toContain(
    "run 42: Error: a test failed",
  );
  expect(p.reruns).toEqual([42]);
  // A check that isn't an Actions run is never rerun.
  pr.checks = () => [{ __typename: "StatusContext", context: "ext/ci", state: "FAILURE" }];
  const third = (await ciHandler.step(cx, atCi())) as Extract<Progress, { done: unknown }>;
  expect(third.done.event).toBe("red");
  expect(p.reruns).toEqual([42]);
  // A first cancel is rerun; a second cancel on the same head counts as red.
  pr.checks = () => [checkRun("test", "CANCELLED", 43)];
  const c = atCi();
  expect(await ciHandler.step(cx, c)).toEqual({ poll: 5 });
  expect(p.reruns).toEqual([42, 43]);
  const c2 = await ciHandler.step(cx, p.mission(c.id)!);
  expect(c2).toEqual({ poll: 5 });
  const c3 = (await ciHandler.step(cx, p.mission(c.id)!)) as Extract<Progress, { done: unknown }>;
  expect(c3.done.event).toBe("red");
  expect(p.reruns).toEqual([42, 43]);
});

test("pipeline: question without a PR goes to the intent", async () => {
  const m = make(ID, 5);
  const out = await ask(cx, m, {
    context: "I was adding the greeting and found two places for it.",
    question: "Where should the greeting go?",
    options: [
      // biome-ignore lint/suspicious/noThenProperty: the spec's key; never awaited.
      { option: "Header", then: "every page shows it" },
      // biome-ignore lint/suspicious/noThenProperty: the spec's key; never awaited.
      { option: "Home only", then: "only the home page shows it" },
    ],
    recommendation: "Home only: smaller change.",
  });
  expect(out).toMatchObject({
    event: "wait",
    waiting: "answer the question",
    why: "Where should the greeting go?",
    data: { question: { question: "Where should the greeting go?" } },
  });
  const i = await p.store.get(ID);
  const t = i.sections.get("Towercab")!;
  expect(t).toContain("I was adding the greeting and found two places for it.");
  expect(t).toContain("**Where should the greeting go?**");
  expect(t).toContain("- **Header**: every page shows it");
  expect(t).toContain("**Recommendation:** Home only: smaller change.");
  expect(p.prs.flatMap((x) => x.comments)).toEqual([]);
});
