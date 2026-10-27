// The pass (LOOP-4, 7, 9, 10, 12, 15, 17): the real loop, store and database, with stage handlers
// faked per test so each test controls what a stage does.

import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { insertCommand } from "../src/commands.ts";
import { fixFor } from "../src/faults.ts";
import type { PrState } from "../src/github/prs.ts";
import {
  type ChildEnd,
  type Ctx,
  EnvError,
  type Handler,
  type Handlers,
  type Progress,
} from "../src/handlers.ts";
import type { IntentStore } from "../src/intents/types.ts";
import { PASS_MS } from "../src/loop.ts";
import { ORDER, ok, wait } from "../src/machine.ts";
import { insertMission, type Mission, unfinished } from "../src/mission.ts";
import { decide } from "../src/pick.ts";
import type { ChildExit, ChildSpec } from "../src/tools.ts";
import { intent, TARGET } from "./helpers/flows.ts";
import { Pipe } from "./helpers/pipe.ts";
import { pushFiles } from "./helpers/world.ts";

const A = "261026-1000";
const B = "261026-1001";
const C = "261026-1002";

type Step = (m: Mission, cx: Ctx) => Progress | Promise<Progress>;
type Finish = (m: Mission, end: ChildEnd, cx: Ctx) => Progress | Promise<Progress>;

/** The same fake handler for every working stage. */
function fake(step: Step, finish: Finish = () => ({ done: ok() })): Handlers {
  const h: Handler = { step: async (cx, m) => step(m, cx), finish: async (cx, m, end) => finish(m, end, cx) };
  return Object.fromEntries(ORDER.filter((s) => s !== "done").map((s) => [s, h]));
}

/** A child the test ends by hand (`end()`), or that hangs. */
function childOf(p: Pipe, kind: string, o: { timeoutMs?: number; model?: string; slot?: boolean } = {}) {
  let end!: (e: ChildExit) => void;
  const done = new Promise<ChildExit>((r) => {
    end = r;
  });
  p.tools.child(kind, () => done);
  const dir = p.home.runs("children");
  const spec: ChildSpec = {
    kind,
    argv: [kind],
    cwd: dir,
    env: {},
    stdout: join(dir, `${kind}.out`),
    stderr: join(dir, `${kind}.err`),
    slot: o.slot ?? true,
    ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
    ...(o.model ? { model: o.model } : {}),
  };
  return { spec, end: () => end({ code: 0, signal: null }) };
}

/** Intent files for the intents repo: id → fields. */
function files(...xs: { id: string; repo?: string; u?: number; i?: number; extra?: string }[]) {
  return Object.fromEntries(
    xs.map((x) => [
      `intents/${x.id}-t${x.id.slice(-1)}/intent.md`,
      intent({
        title: `T${x.id.slice(-1)}`,
        repo: x.repo ?? "web",
        u: x.u ?? 4,
        i: x.i ?? 4,
        extra: x.extra ?? "",
      }),
    ]),
  );
}

const REPOS = { web: { github: "owner/web" }, api: { github: "owner/api" }, docs: { github: "owner/docs" } };

const byIntent = (p: Pipe, id: string) =>
  p.db.all<Mission>("SELECT * FROM missions WHERE intent = ? ORDER BY id", id);

/** One pass, then the clock moves on. */
async function pass(p: Pipe, seconds = 61) {
  const r = await p.loop.pass();
  p.clock.advance(seconds);
  return r;
}

test("loop: picks while others wait", async () => {
  const p = new Pipe(
    TARGET,
    files({ id: A, u: 5, i: 5 }, { id: B, repo: "api" }, { id: C, repo: "docs", u: 3, i: 3 }),
  );
  const b = childOf(p, "work");
  await p.start(
    { repos: REPOS },
    {
      handlers: fake(
        (m) => {
          if (m.intent === B) return { spawn: b.spec };
          return { done: wait("approve spec") };
        },
        () => ({ done: wait("approve plan") }),
      ),
    },
  );
  const picked: (string | null)[] = [];
  for (let i = 0; i < 4; i++) picked.push((await pass(p)).picked);
  // A waits on the owner; B is picked anyway. B's run holds the only slot: C waits for it.
  expect(picked).toEqual([A, B, null, null]);
  expect(byIntent(p, A)[0]!.stage).toBe("approval:spec");
  expect(byIntent(p, B)[0]!.child_kind).toBe("work");
  expect(byIntent(p, C)).toEqual([]);
  b.end();
  await new Promise((r) => setTimeout(r, 5));
  expect((await pass(p)).picked).toBe(C);
  expect(byIntent(p, B)[0]!.stage).toBe("approval:plan");
});

const listCalls = (p: Pipe) => p.issueCalls.filter((c) => c.startsWith("issue list")).length;

test("issues: the poll runs every 5 minutes", async () => {
  const p = new Pipe(TARGET, {});
  await p.start({}, { handlers: {} });
  await p.loop.issuesIdle();
  // On start.
  expect(listCalls(p)).toBe(1);
  for (const [seconds, calls] of [
    [0, 1],
    [299, 1],
    [1, 2],
    [299, 2],
    [1, 3],
  ] as const) {
    p.clock.advance(seconds);
    await p.loop.pass();
    await p.loop.issuesIdle();
    expect(listCalls(p)).toBe(calls);
  }
});

test("issues: a gh failure is a github fault", async () => {
  const p = new Pipe(TARGET, {});
  p.queue("score", () => ({
    structured: { u: 3, u_why: "a", i: 3, i_why: "b", title: "Other repo", problem: "p", outcome: ["o"] },
  }));
  p.issueFail = (args) => (args.includes("owner/web") && args[1] === "list" ? "HTTP 502: bad gateway" : null);
  p.issue({ repo: "owner/api" });
  const repos = { web: { github: "owner/web" }, api: { github: "owner/api" } };
  await p.start({ repos }, { handlers: {} });
  await p.loop.issuesIdle();
  const fault = p.loop.health.open().find((f) => f.kind === "github");
  expect(fault?.error).toContain("owner/web");
  expect(fault?.error).toContain("HTTP 502");
  // The other repo was still read, and its issue queued.
  expect((await p.store.list()).open.map((i) => i.repo)).toEqual(["api"]);
  // The 60 s intents poll works, yet does not hide the failing issue poll.
  p.clock.advance(61);
  await p.loop.pass();
  await p.loop.issuesIdle();
  expect(p.loop.health.open().map((f) => f.kind)).toEqual(["github"]);
  // The next successful issue poll closes it.
  p.issueFail = null;
  p.clock.advance(300);
  await p.loop.pass();
  await p.loop.issuesIdle();
  expect(p.loop.health.open()).toEqual([]);
});

test("loop: one unmerged intent per repo", async () => {
  const p = new Pipe(TARGET, files({ id: A, u: 5, i: 5 }, { id: B }));
  await p.start({}, { handlers: fake(() => ({ done: wait("review and merge PR") })) });
  for (let i = 0; i < 4; i++) await pass(p);
  expect(byIntent(p, A)[0]!.stage).toBe("approval:merge");
  expect(byIntent(p, B)).toEqual([]);
  const listing = await p.store.list();
  expect(decide(listing, p.loop.pickState()).skipped).toContainEqual({
    id: B,
    reason: "repo web full (1/1)",
  });
  // The owner merges A's PR: the repo is free again.
  p.loop.move(byIntent(p, A)[0]!, { event: "code_merged", set: { merge_sha: "abc", merged_by: "owner" } });
  await pass(p);
  await pass(p);
  expect(byIntent(p, A)[0]!.stage).toBe("done");
  expect(byIntent(p, B)).toHaveLength(1);

  // With `workers = 2` both run at once.
  const q = new Pipe(TARGET, files({ id: A, u: 5, i: 5 }, { id: B }));
  await q.start(
    { repos: { web: { github: "owner/web", workers: 2 } } },
    { handlers: fake(() => ({ done: wait("review and merge PR") })) },
  );
  for (let i = 0; i < 3; i++) await pass(q);
  expect(unfinished(q.db).map((m) => [m.intent, m.stage])).toEqual([
    [A, "approval:merge"],
    [B, "approval:merge"],
  ]);
});

test("loop: one mission per intent", async () => {
  const p = new Pipe(TARGET, files({ id: A }));
  await p.start({}, { handlers: fake(() => ({ done: wait("answer the question") })) });
  for (let i = 0; i < 5; i++) await pass(p);
  expect(byIntent(p, A)).toHaveLength(1);
  // The database refuses a second unfinished mission.
  expect(() =>
    insertMission(p.db, { intent: A, slug: "t0", repo: "web", model: "opus", a: 5 }, p.clock.now()),
  ).toThrow(/UNIQUE/);
  // A fresh attempt replaces it: still one unfinished.
  p.loop.move(byIntent(p, A)[0]!, { event: "retry_fresh" });
  for (let i = 0; i < 3; i++) await pass(p);
  const ms = byIntent(p, A);
  expect(ms.map((m) => [m.attempt, m.stage])).toEqual([
    [1, "stopped"],
    [2, "blocked"],
  ]);
});

test("loop: SIGTERM is not counted", async () => {
  const p = new Pipe(TARGET, files({ id: A }));
  let steps = 0;
  await p.start(
    {},
    {
      handlers: fake((m, cx) => {
        if (m.stage === "pick") return { done: ok() };
        steps++;
        cx.record(m, "work");
        return { spawn: childOf(p, "work").spec };
      }),
    },
  );
  for (let i = 0; i < 3; i++) await pass(p);
  expect(p.mission()!.child_kind).toBe("work");
  // What `run` does on SIGTERM or SIGINT.
  p.loop.stop(0);
  await p.loop.shutdown();
  expect(p.loop.exitCode).toBe(0);
  expect(p.tools.kills.filter((k) => k.kind === "work")).toEqual([{ kind: "work", signal: "SIGTERM" }]);
  const m = p.mission()!;
  expect([m.stage, m.step, m.busy, m.unclean, m.child_pid]).toEqual(["design", "work", 0, 0, null]);
  expect(p.db.meta("running")).toBeNull();
  // The next start isn't a recovery, and the step runs again.
  await p.reopen();
  expect(p.logs.some((l) => l.includes("didn't exit cleanly"))).toBe(false);
  await pass(p);
  expect(steps).toBe(2);
  expect(p.mission()!.unclean).toBe(0);
});

test("loop: three crashes wait for the owner", async () => {
  const p = new Pipe(TARGET, files({ id: A }));
  await p.start(
    {},
    {
      handlers: fake((m, cx) => {
        if (m.stage === "pick") return { done: ok() };
        cx.record(m, "work");
        return { spawn: childOf(p, "work").spec };
      }),
    },
  );
  for (let i = 0; i < 3; i++) await pass(p);
  expect(p.mission()!.busy).toBe(1);
  const unclean: number[] = [];
  for (let i = 0; i < 3; i++) {
    // Killed hard: `meta.running` is still there at the next start.
    expect(p.db.meta("running")).not.toBeNull();
    await p.reopen();
    unclean.push(p.mission()!.unclean);
    await pass(p);
  }
  expect(unclean).toEqual([1, 2, 0]);
  const m = p.mission()!;
  expect([m.stage, m.waiting, m.from_stage]).toEqual(["blocked", "crashed at design", "design"]);
  expect(p.logs.filter((l) => l.includes("didn't exit cleanly"))).toHaveLength(3);
  const msg = p.db.get<{ text: string }>("SELECT text FROM outbox WHERE mission = ?", m.id)!.text;
  expect(msg.split("\n")[0]).toBe("Towercab crashed three times at this step.");
});

test("limits: other models run", async () => {
  const p = new Pipe(
    TARGET,
    files(
      { id: A, u: 5, i: 5 },
      { id: C, repo: "docs", u: 4, i: 4 },
      { id: B, repo: "api", u: 3, i: 3, extra: "model: sonnet\n" },
    ),
  );
  const steps: string[] = [];
  let cooled = false;
  await p.start(
    { repos: REPOS },
    {
      handlers: fake((m, cx) => {
        steps.push(`${m.intent} ${m.stage}`);
        if (m.intent === A && !cooled) {
          cooled = true;
          const now = cx.clock.now();
          return {
            done: {
              event: "limit",
              limit: { model: "opus", until: now + 3600, backoffs: 0, text: "usage limit" },
            },
          };
        }
        return m.stage === "pick" ? { done: ok() } : { done: wait("approve spec") };
      }),
    },
  );
  for (let i = 0; i < 5; i++) await pass(p);
  const a = byIntent(p, A)[0]!;
  expect([a.stage, a.limit_model]).toEqual(["pick", "opus"]);
  // Sonnet's intent was picked and worked on; opus's next intent waits for the cooldown.
  expect(byIntent(p, B)[0]!.stage).toBe("approval:spec");
  expect(byIntent(p, C)).toEqual([]);
  const listing = await p.store.list();
  expect(decide(listing, p.loop.pickState()).skipped.find((s) => s.id === C)?.reason).toMatch(
    /^opus cooling until \d\d:\d\d$/,
  );
  expect(steps.filter((s) => s === `${A} pick`)).toHaveLength(1);
  // After the reset, the same step runs again, and opus picks up new work.
  p.clock.advance(3600);
  for (let i = 0; i < 3; i++) await pass(p);
  expect(steps.filter((s) => s === `${A} pick`)).toHaveLength(2);
  expect(byIntent(p, A)[0]!.stage).toBe("approval:spec");
  expect(byIntent(p, C)).toHaveLength(1);
});

test("faults: one message after 15 minutes", async () => {
  const p = new Pipe(TARGET, files({ id: A, repo: "web" }));
  let down = true;
  await p.start(
    { repos: REPOS },
    {
      // Each design step is a Claude run; while Claude is down its end is a network failure.
      handlers: fake(
        (m) => {
          if (m.stage === "pick") return { done: ok() };
          const c = childOf(p, "design", { model: "opus" });
          c.end();
          return { spawn: c.spec };
        },
        () => {
          if (down) throw new EnvError("claude", "API Error: Connection error: ECONNREFUSED");
          return { done: wait("approve spec") };
        },
      ),
    },
  );
  const health = () =>
    p.db.all<{ key: string; text: string; created: number }>(
      "SELECT key, text, created FROM outbox WHERE key LIKE 'health:%'",
    );
  for (let i = 0; i < 30 && health().length === 0; i++) await pass(p, 60);
  const since = p.loop.health.open()[0]!.since;
  expect(health()).toHaveLength(1);
  // Sent on the first pass 15 minutes after the first failure, naming the fix.
  expect(health()[0]!.created - since).toBeGreaterThanOrEqual(15 * 60);
  expect(health()[0]!.created - since).toBeLessThan(16 * 60);
  expect(health()[0]!.text).toBe(
    `Towercab can't reach claude and has paused new work.\nAPI Error: Connection error: ECONNREFUSED\n${fixFor("claude")}`,
  );
  // Picks pause: a new intent waits; the outage stays one message however long it lasts.
  pushFiles(p.bares.intents!, files({ id: B, repo: "api" }));
  for (let i = 0; i < 10; i++) await pass(p, 60);
  expect(byIntent(p, B)).toEqual([]);
  expect(byIntent(p, A)[0]!.stage).toBe("design");
  expect(health()).toHaveLength(1);
  // Claude answers again: the fault closes and picks resume.
  down = false;
  for (let i = 0; i < 6; i++) await pass(p, 60);
  expect(byIntent(p, A)[0]!.stage).toBe("approval:spec");
  expect(byIntent(p, B)).toHaveLength(1);
  expect(health()).toHaveLength(1);
});

/** A PR read as `gh` gives it, with the owner's comments. */
function prState(o: Partial<PrState> = {}): PrState {
  return {
    state: "OPEN",
    mergedAt: null,
    mergeCommit: null,
    head: "a".repeat(40),
    mergeable: "MERGEABLE",
    body: "",
    isDraft: false,
    reviews: [],
    comments: [],
    ...o,
  };
}

test("loop: polls while a child runs", async () => {
  const p = new Pipe(TARGET, files({ id: A }));
  let pr = prState();
  const reads: number[] = [];
  await p.start(
    {},
    {
      readPr: async (_repo, n) => {
        reads.push(n);
        return pr;
      },
      handlers: fake((m) => {
        if (m.stage === "verify") return { spawn: childOf(p, "work").spec };
        return { done: ok(m.stage === "pick" ? { set: { pr: 7, head: "a".repeat(40) } } : {}) };
      }),
    },
  );
  for (let i = 0; i < 6; i++) await pass(p);
  expect(p.mission()!.stage).toBe("verify");
  expect(p.mission()!.child_kind).toBe("work");
  const before = reads.length;
  // The owner comments while the check runs: read every minute, held until the child ends.
  pr = prState({ comments: [{ author: "owner", body: "Use blue.", at: p.at(), id: "1" }] });
  for (let i = 0; i < 3; i++) await pass(p);
  expect(reads.length - before).toBe(3);
  expect(p.mission()!.stage).toBe("verify");
  // Closing the PR moves it at once, and the move kills the child.
  pr = prState({ state: "CLOSED" });
  await pass(p);
  await pass(p);
  expect(p.mission()!.stage).toBe("stopped");
  expect(p.tools.kills.filter((k) => k.kind === "work").map((k) => k.signal)).toEqual(["SIGTERM"]);
});

test("loop: cadence", async () => {
  expect(PASS_MS).toBe(5000);
  const p = new Pipe(TARGET, files({ id: A }));
  let lists = 0;
  const reads: number[] = [];
  const steps: number[] = [];
  await p.start(
    {},
    {
      wrapStore: (s) => {
        const counted = Object.create(s) as IntentStore;
        counted.list = () => {
          lists++;
          return s.list();
        };
        return counted;
      },
      readPr: async () => {
        reads.push(p.clock.now());
        return prState();
      },
      handlers: fake((m) => {
        if (m.stage === "pick") return { done: ok({ set: { pr: 7 } }) };
        steps.push(p.clock.now());
        return { poll: 30 };
      }),
    },
  );
  const t0 = p.clock.now();
  // On start: the intents poll, and the issue poll's own read of the intents (INT-21).
  await p.loop.issuesIdle();
  expect(lists).toBe(2);
  // Three minutes of 5-second passes.
  for (let i = 0; i < 36; i++) await pass(p, 5);
  const at = (ts: number[]) => ts.map((t) => t - t0);
  // Intents every 60 s; the PR every 60 s from its first read; the stage at its own poll (30 s).
  expect(lists).toBe(2 + 2);
  expect(at(reads)).toEqual([10, 70, 130]);
  expect(at(steps)).toEqual([10, 40, 70, 100, 130, 160]);
});

test("loop: timeout kills the group", async () => {
  const p = new Pipe(TARGET, files({ id: A }));
  p.tools.stubborn.add("work");
  const kills: [string, number][] = [];
  let end: ChildEnd | null = null;
  let t0 = 0;
  await p.start(
    {},
    {
      handlers: fake(
        (m, cx) => {
          if (m.stage === "pick") return { done: ok() };
          // 20 s of this step already ran (before a restart): 40 s of the 60 s budget are left.
          cx.db.run("UPDATE missions SET step_secs = 20 WHERE id = ?", m.id);
          t0 = cx.clock.now();
          return { spawn: childOf(p, "work", { timeoutMs: 60_000 }).spec };
        },
        (_m, e) => {
          end = e;
          return { done: wait("worker timeout") };
        },
      ),
    },
  );
  await pass(p, 0);
  await pass(p, 0);
  await pass(p, 5);
  expect(p.tools.spawned.find((s) => s.kind === "work")!.timeoutMs).toBe(40_000);
  for (let i = 0; i < 20 && !end; i++) {
    const n = p.tools.kills.length;
    await pass(p, 5);
    for (const k of p.tools.kills.slice(n).filter((x) => x.kind === "work"))
      kills.push([k.signal, p.clock.now() - 5 - t0]);
    await new Promise((r) => setTimeout(r, 2));
  }
  // SIGTERM to the group past the budget; it doesn't stop, so SIGKILL 10 s later.
  expect(kills).toEqual([
    ["SIGTERM", 45],
    ["SIGKILL", 60],
  ]);
  expect(end).toMatchObject({ timedOut: true, signal: "SIGKILL" });
  expect(p.mission()!.waiting).toBe("worker timeout");
});

test("loop: idle", async () => {
  const p = new Pipe(TARGET, { "README.md": "intents\n" });
  await p.start({}, { watch: false });
  const r = await p.loop.pass();
  expect(r).toMatchObject({ idle: true, picked: null, stop: false });
  expect(p.db.all("SELECT * FROM outbox")).toEqual([]);
  expect(p.tools.spawned).toEqual([]);
  // Without --watch, `run` ends once nothing is runnable.
  const t = Date.now();
  expect(await p.loop.run()).toBe(0);
  expect(Date.now() - t).toBeLessThan(PASS_MS);
  expect(p.db.meta("running")).toBeNull();
  // With --watch it keeps passing every 5 s, quietly, until stopped.
  const w = new Pipe(TARGET, { "README.md": "intents\n" });
  await w.start({}, { watch: true });
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  try {
    let ended: number | null = null;
    const passes = vi.spyOn(w.loop, "pass");
    void w.loop.run().then((code) => {
      ended = code;
    });
    for (let i = 0; i < 4; i++) {
      await vi.waitFor(() => expect(passes).toHaveBeenCalledTimes(i + 1), { timeout: 5000 });
      await vi.advanceTimersByTimeAsync(PASS_MS);
    }
    expect(ended).toBeNull();
    expect(w.db.all("SELECT * FROM outbox")).toEqual([]);
    w.loop.stop(0);
    await vi.advanceTimersByTimeAsync(PASS_MS);
    await vi.waitFor(() => expect(ended).toBe(0), { timeout: 5000 });
  } finally {
    vi.useRealTimers();
  }
});

test("commands: applied by the loop", async () => {
  const p = new Pipe(TARGET, files({ id: A }));
  await p.start(
    {},
    { handlers: fake((m) => (m.stage === "pick" ? { done: ok() } : { done: wait("answer the question") })) },
  );
  const cmd = (name: "answer" | "retry" | "drop" | "pause" | "resume", arg = "", text = "") =>
    insertCommand(p.db, { name, arg, text, source: "cli" }, p.clock.now());
  const result = (id: number) =>
    p.db.get<{ result: string; applied_at: number | null }>(
      "SELECT result, applied_at FROM commands WHERE id = ?",
      id,
    )!;

  const pause = cmd("pause");
  await pass(p);
  expect(result(pause).result).toBe("paused: nothing new starts, and merges wait until you resume");
  expect(byIntent(p, A)).toEqual([]);
  const resume = cmd("resume");
  await pass(p);
  expect(result(resume).result).toBe("resumed");
  expect(byIntent(p, A)).toHaveLength(1);
  await pass(p);
  await pass(p);
  expect(p.mission()!.waiting).toBe("answer the question");

  const answer = cmd("answer", A, "Use blue.");
  await pass(p);
  expect(result(answer).result).toBe(`answered ${A}; it continues`);
  expect(JSON.parse(p.mission()!.data).answer).toBe("Use blue.");
  expect((await p.store.get(A)).sections.get("Answers")).toMatch(/: Use blue\.$/);

  const retry = cmd("retry", A);
  await pass(p);
  expect(result(retry).result).toBe(`fresh attempt 2 for ${A}`);
  expect(byIntent(p, A).map((m) => [m.attempt, m.stage])).toEqual([
    [1, "stopped"],
    [2, "design"],
  ]);

  const drop = cmd("drop", A);
  await pass(p);
  expect(result(drop).result).toBe(`dropped ${A}`);
  expect(byIntent(p, A).map((m) => m.stage)).toEqual(["stopped", "stopped"]);
  expect((await p.store.list()).done.find((i) => i.id === A)?.stage).toBe("dropped");
  expect(p.db.all("SELECT id FROM commands WHERE applied_at IS NULL")).toEqual([]);
});
