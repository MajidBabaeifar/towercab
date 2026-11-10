// A plan too big for one run is built over several (PIP-216..219): the next run carries on from the first
// open step in a fresh session, and the review starts once every step is built.

import { expect, test } from "vitest";
import { insertCommand } from "../../src/commands.ts";
import { parseConfig } from "../../src/config.ts";
import { build, happy, ID, intent, intents, PLAN, reply, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

const SIX =
  "## Approach\n\nA plan of six steps.\n\n## Steps\n\n1. One\n2. Two\n3. Three\n4. Four\n5. Five\n6. Six\n\n## Risks\n\nNone.\n\n## How to check it\n\nRun the tests.";

/** Run `n` of the build: it writes its own file and test, and says how many steps are built. */
function run(n: number, done: number | null, more: Record<string, unknown> = {}) {
  return reply(
    build({
      steps_done: done,
      handoff: done === null ? null : `Steps up to ${done} are built; next is ${done + 1}.`,
      ...more,
    }),
    { [`s${n}.txt`]: `${n}\n`, [`tests/s${n}.sh`]: `test -f s${n}.txt\n` },
    { cost: 1 },
  );
}

/** Run 1 leaves out the file its own test looks for, so the checks are red until a repair adds it. */
function unfinished() {
  return reply(
    build({ steps_done: 2, handoff: "Two built." }),
    { "tests/s1.sh": "test -f s1.txt\n" },
    { cost: 1 },
  );
}

/** A run that never ends on its own: the test looks at the mission while it is going. */
const going = () => reply(build(), {}, { hang: true });

function sixSteps(p: Pipe): void {
  happy(p);
  p.respond.plan = reply({ ...PLAN, plan: SIX });
}

const workers = (p: Pipe) => p.claudeCalls.filter((c) => c.kind === "worker");
const buildOf = (p: Pipe) => JSON.parse(p.mission()!.data).build;

async function untilWorkers(p: Pipe, n: number): Promise<void> {
  const passes = await p.until(() => workers(p).length >= n, 200);
  if (passes < 0) throw new Error(`never reached ${n} worker runs\n${p.moves()}`);
}

test("pipeline: a six-step plan builds in three runs and then goes to review", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  sixSteps(p);
  p.queue("worker", run(1, 2), run(2, 4), run(3, null));
  await p.start();
  const id = () => p.mission()!.id;
  const n = await p.until(() => p.stages(id()).includes("review"), 200);
  expect(n, p.moves()).toBeGreaterThan(0);
  expect(workers(p)).toHaveLength(3);
  const stages = p.stages(id());
  // Three runs, each published; the review comes after the third.
  expect(stages.filter((s) => s === "build")).toHaveLength(3);
  expect(stages.slice(0, stages.indexOf("review")).filter((s) => s === "publish")).toHaveLength(3);
  const more = p.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM transitions WHERE event = 'more_steps'");
  expect(more!.c).toBe(2);
  expect(buildOf(p)).toMatchObject({ stepsDone: 6, stepsTotal: 6, runs: 3 });
  // One branch, one PR.
  expect(p.show("web", p.mission()!.branch, "s3.txt")).toBe("3\n");
}, 120_000);

test("pipeline: open steps send the mission back to build, not review", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  sixSteps(p);
  p.queue("worker", run(1, 2), going());
  await p.start();
  await untilWorkers(p, 2);
  const m = p.mission()!;
  expect(m.stage).toBe("build");
  expect(p.stages(m.id)).not.toContain("review");
  expect(p.stages(m.id)).not.toContain("ci");
  expect(p.prs.some((x) => x.repo === "web")).toBe(true);
  expect(buildOf(p)).toMatchObject({ stepsDone: 2, stepsTotal: 6, runs: 1 });
}, 120_000);

test("pipeline: intermediate runs count no repair", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  sixSteps(p);
  p.queue("worker", run(1, 2), going());
  await p.start();
  await untilWorkers(p, 2);
  const m = p.mission()!;
  expect(m.repairs).toBe(0);
  expect(m.ci_repairs).toBe(0);
  expect(workers(p)[1]!.prompt).toContain("Build the intent below now");
}, 120_000);

test("pipeline: the build prompt names the steps already built", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  sixSteps(p);
  p.queue("worker", run(1, 2), going());
  await p.start();
  await untilWorkers(p, 2);
  const [first, second] = workers(p);
  expect(first!.prompt).not.toContain("plan too big for one run");
  expect(second!.prompt).toContain("Steps 1 to 2 of 6 are built");
  expect(second!.prompt).toContain("start at step 3");
  expect(second!.prompt).toContain("1. One\n2. Two");
  // The built list holds steps 1 and 2 only (the plan itself, fenced above it, names them all).
  const built = second!.prompt.split("Steps already built:\n")[1]!.split("\n\n")[0];
  expect(built).toBe("1. One\n2. Two");
}, 120_000);

test("pipeline: a later build run starts a new session", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  sixSteps(p);
  p.queue("worker", run(1, 2), going());
  await p.start();
  await untilWorkers(p, 2);
  const [first, second] = workers(p);
  // Run 1 resumes the mission's session (design and plan used it); run 2 does not.
  expect(second!.session.mode).toBe("new");
  expect(second!.session.id).not.toBe(first!.session.id);
}, 120_000);

test("pipeline: the later run prompt has the plan, built steps and the handoff note", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  sixSteps(p);
  p.queue("worker", run(1, 2, { handoff: "Step 2 left a TODO in s1.txt." }), going());
  await p.start();
  await untilWorkers(p, 2);
  const prompt = workers(p)[1]!.prompt;
  expect(prompt).toContain("5. Five");
  expect(prompt).toContain("<handoff>\nStep 2 left a TODO in s1.txt.\n</handoff>");
  expect(prompt).toContain("Steps already built:");
}, 120_000);

test("pipeline: built steps are read from the branch commits", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  sixSteps(p);
  p.queue("worker", run(1, 2), going());
  await p.start();
  await untilWorkers(p, 2);
  expect(workers(p)[1]!.prompt).toMatch(/Commits on the branch so far:\n- \w+/);
}, 120_000);

test("pipeline: a run with steps open and no handoff is asked for it", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  sixSteps(p);
  p.queue(
    "worker",
    run(1, 2, { handoff: null }),
    reply(build({ steps_done: 2, handoff: "Asked for, given." }), {}),
    going(),
  );
  await p.start();
  await untilWorkers(p, 3);
  const [first, asked, next] = workers(p);
  // The note is asked for once, in the run's own session.
  expect(asked!.prompt).toContain("needs a `handoff`");
  expect(asked!.session.mode).toBe("resume");
  expect(asked!.session.id).toBe(first!.session.id);
  expect(next!.prompt).toContain("Asked for, given.");
}, 120_000);

test("pipeline: a repair round resumes the run's session", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  sixSteps(p);
  // Run 1 leaves the file its test looks for out; the repair adds it and says nothing about steps.
  p.queue(
    "worker",
    unfinished(),
    reply(build({ steps_done: null, handoff: null }), { "s1.txt": "1\n" }),
    going(),
  );
  await p.start();
  await untilWorkers(p, 3);
  const [first, repair, next] = workers(p);
  expect(repair!.session.mode).toBe("resume");
  expect(repair!.session.id).toBe(first!.session.id);
  expect(next!.session.mode).toBe("new");
  expect(next!.session.id).not.toBe(first!.session.id);
  // The repair's `null` is not read as "every step built".
  expect(buildOf(p)).toMatchObject({ stepsDone: 2, stepsTotal: 6 });
}, 120_000);

test("pipeline: a run with no new commits counts as no progress", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  sixSteps(p);
  p.queue("worker", run(1, 2), reply(build({ steps_done: 2, handoff: "Nothing came of it." }), {}), going());
  await p.start();
  await untilWorkers(p, 3);
  const m = p.mission()!;
  // Not `no changes`: the next run starts, fresh.
  expect(m.stage).toBe("build");
  expect(buildOf(p)).toMatchObject({ stalled: 1, stepsDone: 2 });
  expect(workers(p)[2]!.session.mode).toBe("new");
}, 120_000);

test("pipeline: two runs without progress ask the owner", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  sixSteps(p);
  const nothing = reply(build({ steps_done: 2, handoff: "Nothing came of it." }), {});
  p.queue("worker", run(1, 2), nothing, nothing);
  await p.start();
  const n = await p.until(() => p.mission()?.stage === "blocked", 200);
  expect(n, p.moves()).toBeGreaterThan(0);
  const m = p.mission()!;
  expect(m.waiting).toBe("answer the question");
  expect(JSON.parse(m.data).question.context).toContain("2 of 6 plan steps are built");
  expect(workers(p)).toHaveLength(3);
}, 120_000);

test("pipeline: a run with progress resets the stall count", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  sixSteps(p);
  p.queue("worker", run(1, 2), reply(build({ steps_done: 2, handoff: "Nothing." }), {}), run(2, 4), going());
  await p.start();
  await untilWorkers(p, 4);
  expect(buildOf(p)).toMatchObject({ stalled: 0, stepsDone: 4 });
}, 120_000);

test("pipeline: a run with red checks after repairs is no progress", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  sixSteps(p);
  // The test looks for a file no round writes, so the checks stay red; each repair still changes something.
  const red = (tag: string) =>
    reply(build({ steps_done: null, handoff: null }), { [`junk-${tag}.txt`]: "x\n" });
  p.queue("worker", unfinished(), red("a"), red("b"));
  await p.start();
  const n = await p.until(() => p.mission()?.waiting === "checks red", 200);
  expect(n, p.moves()).toBeGreaterThan(0);
  expect(buildOf(p)).toMatchObject({ stalled: 1, stepsDone: 2 });
}, 120_000);

test("pipeline: each run of a long build gets the per-run limit", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  sixSteps(p);
  p.queue("worker", run(1, 2), run(2, 4), going());
  await p.start({ agent: { max_budget_usd: 4 } });
  await untilWorkers(p, 3);
  for (const c of workers(p)) {
    const at = c.argv.indexOf("--max-budget-usd");
    expect(c.argv[at + 1]).toBe("4");
  }
}, 120_000);

test("pipeline: all runs of a long build count in the intent's spend", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  sixSteps(p);
  p.queue("worker", run(1, 2), run(2, 4), going());
  await p.start();
  await untilWorkers(p, 3);
  const spent = p.mission()!.cost_usd;
  // The two finished runs cost 1 each, in sessions of their own.
  expect(spent).toBeGreaterThanOrEqual(2);
}, 120_000);

test("pipeline: max_build_runs stops a long build with steps open and asks", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  sixSteps(p);
  p.queue("worker", run(1, 2), run(2, 4));
  await p.start({ agent: { max_build_runs: 2 } });
  const n = await p.until(() => p.mission()?.waiting === "worker budget", 200);
  expect(n, p.moves()).toBeGreaterThan(0);
  expect(workers(p)).toHaveLength(2);
  const m = p.mission()!;
  expect(m.stage).toBe("blocked");
  expect(m.why).toContain("2 build runs built 4 of 6 plan steps");
  expect(buildOf(p)).toMatchObject({ stepsDone: 4, stepsTotal: 6 });
}, 120_000);

test("pipeline: the owner's reply grants another set of runs", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  sixSteps(p);
  p.queue("worker", run(1, 2), run(2, 4), run(3, null));
  await p.start({ agent: { max_build_runs: 2 } });
  await p.until(() => p.mission()?.waiting === "worker budget", 200);
  insertCommand(p.db, { name: "answer", arg: ID, text: "Carry on", source: "cli" }, p.clock.now());
  const n = await p.until(() => p.stages(p.mission()!.id).includes("review"), 200);
  expect(n, p.moves()).toBeGreaterThan(0);
  const calls = workers(p);
  expect(calls).toHaveLength(3);
  // It resumes at the first open step, in a fresh session, with the owner's words.
  expect(calls[2]!.session.mode).toBe("new");
  expect(calls[2]!.prompt).toContain("Steps 1 to 4 of 6 are built");
  expect(calls[2]!.prompt).toContain("Carry on");
}, 120_000);

test("pipeline: a long build resumes at the first open step after a pause", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  sixSteps(p);
  p.queue("worker", run(1, 2), run(2, 4), going());
  await p.start({ agent: { max_build_runs: 2 } });
  await p.until(() => p.mission()?.waiting === "worker budget", 200);
  insertCommand(p.db, { name: "answer", arg: ID, text: "Go on", source: "cli" }, p.clock.now());
  await untilWorkers(p, 3);
  expect(workers(p)[2]!.prompt).toContain("start at step 5");
}, 120_000);

test("pipeline: a repo cap pauses a long build between runs", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  sixSteps(p);
  p.queue("worker", run(1, 2), going());
  // Run 1 costs $1, which reaches web's daily cap of $1: the build is underway, so it finishes the run
  // and its push, but the next run is new work and waits.
  await p.start({ budget: { web: { daily_usd: 1 } } });
  await p.until(() => buildOf(p)?.due === true, 200);
  await p.until(() => false, 15);
  expect(workers(p)).toHaveLength(1);
  const m = p.mission()!;
  expect(m.stage).toBe("build");
  expect(buildOf(p)).toMatchObject({ stepsDone: 2, due: true });
}, 120_000);

test("pipeline: max_build_runs is read from config.toml and a bad value is ignored", () => {
  const base = {
    intents: { remote: "https://github.com/me/intents.git" },
    repos: { web: { github: "me/web" } },
    github: { app_id: 7, me: "me" },
  };
  const runs = (v: unknown) =>
    parseConfig({ ...base, agent: v === undefined ? {} : { max_build_runs: v } }, "/x/config.toml").agent
      .maxBuildRuns;
  expect(runs(undefined)).toBe(3);
  expect(runs(5)).toBe(5);
  expect(runs(0)).toBe(3);
  expect(runs("many")).toBe(3);
});
