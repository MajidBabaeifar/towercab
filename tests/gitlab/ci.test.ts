// GitLab build results (GL-11, GL-12): a merge request's pipelines and jobs become the checks of PIP-3,
// and a first red or cancelled pipeline is retried once before a repair round reads the job logs.

import { expect, test } from "vitest";
import { GitLabForge } from "../../src/forge/gitlab.ts";
import type { Ctx } from "../../src/handlers.ts";
import type { Mission } from "../../src/mission.ts";
import { bucket, ciHandler } from "../../src/pipeline/ci.ts";
import { LOG_TAIL } from "../../src/pipeline/job-log.ts";
import { FakeGitLab, type FakeMr, gitlabConfig } from "../helpers/gitlab.ts";

const SLUG = "gitlab:grp/web";
const GRACE = 60;
const WAIT = 1800;
const CREATED = Date.parse("2026-11-05T10:00:00Z") / 1000;
/** The push happened just before the pipelines were created. */
const PUSHED = CREATED - 5;

function setup() {
  const gl = new FakeGitLab();
  gl.project("grp/web");
  const mr = gl.mr("grp/web", { sha: "c".repeat(40) });
  const forge = new GitLabForge(gitlabConfig().cfg, gl.http);
  return { gl, mr, forge };
}

async function buckets(forge: GitLabForge, mr: FakeMr, now = PUSHED + 1000) {
  const v = await forge.readChecks(SLUG, mr.iid);
  return { v, b: bucket(v.checks, PUSHED, now, GRACE) };
}

/** A context with only what the CI handler reads; `record` keeps the mission's data as the loop does. */
function ctx(forge: GitLabForge, now: () => number, timeouts = false) {
  const cx = {
    github: forge,
    clock: { now },
    timeouts,
    config: { agent: { ciPoll: 5, ciGrace: GRACE, ciWait: WAIT } },
    repo: () => ({ github: SLUG }),
    record(m: Mission, step: string, set: Record<string, unknown> = {}, data: Record<string, unknown> = {}) {
      Object.assign(m, set, { step, data: JSON.stringify({ ...JSON.parse(m.data), ...data }) });
      return m;
    },
  };
  return cx as unknown as Ctx;
}

/** A clock that moves on at every read, as time does between two polls. */
function ticking(): () => number {
  let t = PUSHED + 1000;
  return () => {
    t += 100;
    return t;
  };
}

function mission(mr: FakeMr): Mission {
  return { pr: mr.iid, head: mr.sha, pushed_at: PUSHED, ci_repairs: 0, step: "ci", data: "{}" } as Mission;
}

test("gitlab ci: only pipelines of the pushed head count", async () => {
  const { gl, mr, forge } = setup();
  gl.pipeline(mr, [["old-test", "failed"]], { sha: "d".repeat(40) });
  gl.pipeline(mr, [["test", "success"]]);
  const { v, b } = await buckets(forge, mr);
  expect(v.head).toBe(mr.sha);
  expect(v.checks.map((c) => c.name)).toEqual(["test"]);
  expect(b.kind).toBe("green");
});

test("gitlab ci: job statuses map to the CI buckets", async () => {
  const { gl, mr, forge } = setup();
  gl.pipeline(mr, [
    ["a", "success"],
    ["b", "failed"],
    ["c", "canceled"],
    ["d", "skipped"],
    ["e", "running"],
  ]);
  const { v } = await buckets(forge, mr);
  const by = Object.fromEntries(v.checks.map((c) => [c.name, `${c.status}/${c.conclusion}`]));
  expect(by).toEqual({
    a: "COMPLETED/SUCCESS",
    b: "COMPLETED/FAILURE",
    c: "COMPLETED/CANCELLED",
    e: "PENDING/",
  });
  // Each alone sorts to its bucket; the skipped job is not there to count.
  const alone = async (status: string) => {
    const s = setup();
    s.gl.pipeline(s.mr, [["only", status]]);
    return (await buckets(s.forge, s.mr)).b.kind;
  };
  expect(await alone("success")).toBe("green");
  expect(await alone("failed")).toBe("red");
  expect(await alone("canceled")).toBe("cancel");
  expect(await alone("running")).toBe("pending");
  expect(await alone("skipped")).toBe("none");
});

test("gitlab ci: an allowed failure is neutral", async () => {
  const { gl, mr, forge } = setup();
  gl.pipeline(mr, [
    ["test", "success"],
    ["lint", "failed", { allow_failure: true }],
  ]);
  const { v, b } = await buckets(forge, mr);
  expect(v.checks.find((c) => c.name === "lint")?.conclusion).toBe("NEUTRAL");
  expect(b.kind).toBe("green");
});

test("gitlab ci: a manual job keeps the pipeline pending and is named", async () => {
  const { gl, mr, forge } = setup();
  gl.pipeline(mr, [
    ["test", "success"],
    ["deploy", "manual"],
    ["optional", "manual", { allow_failure: true }],
  ]);
  const { b } = await buckets(forge, mr);
  expect(b).toEqual({ kind: "pending", runs: [], manual: "deploy" });
  // Before the CI wait runs out the step polls; after it, the owner is told which job waits.
  const m = mission(mr);
  expect(
    await ciHandler.step(
      ctx(forge, () => PUSHED + 1000, true),
      m,
    ),
  ).toEqual({ poll: 5 });
  const late = await ciHandler.step(
    ctx(forge, () => PUSHED + WAIT + 10, true),
    m,
  );
  expect(late).toEqual({ done: expect.objectContaining({ event: "wait", waiting: "CI stuck" }) });
  expect("done" in late && late.done.why).toBe("job deploy is waiting for a manual start");
  expect(gl.calls().some((c) => c.startsWith("POST") && c.includes("/cancel"))).toBe(false);
});

test("gitlab ci: several pipelines for one head all count", async () => {
  const { gl, mr, forge } = setup();
  gl.pipeline(mr, [["build", "success"]]);
  gl.pipeline(mr, [["e2e", "failed"]]);
  const { v, b } = await buckets(forge, mr);
  expect(v.checks.map((c) => [c.name, c.run])).toEqual([
    ["build", 1],
    ["e2e", 2],
  ]);
  expect(b.kind).toBe("red");
  const second = setup();
  second.gl.pipeline(second.mr, [["build", "success"]]);
  second.gl.pipeline(second.mr, [["e2e", "running"]]);
  expect((await buckets(second.forge, second.mr)).b).toEqual({ kind: "pending", runs: [2] });
});

test("gitlab ci: no pipelines is green after the grace window", async () => {
  const { gl, mr, forge } = setup();
  // Within the grace window nothing yet is pending, after it there is no CI on the repo.
  expect((await buckets(forge, mr, PUSHED + 10)).b).toEqual({ kind: "pending", runs: [] });
  expect((await buckets(forge, mr, PUSHED + GRACE + 1)).b).toEqual({ kind: "none" });
  const m = mission(mr);
  const done = await ciHandler.step(
    ctx(forge, () => PUSHED + GRACE + 1),
    m,
  );
  expect(done).toEqual({ done: expect.objectContaining({ event: "ok", why: "no CI on this repo" }) });
  // A pipeline created before the push is ignored inside the grace window.
  gl.pipeline(mr, [["test", "failed"]], { created_at: "2026-11-05T09:00:00Z" });
  expect((await buckets(forge, mr, PUSHED + 10)).b).toEqual({ kind: "pending", runs: [] });
});

test("gitlab ci: a first red pipeline is retried once", async () => {
  const { gl, mr, forge } = setup();
  const pl = gl.pipeline(mr, [["test", "failed", { trace: "Error: a test failed\n" }]]);
  const m = mission(mr);
  const cx = ctx(forge, ticking());
  expect(await ciHandler.step(cx, m)).toEqual({ poll: 5 });
  expect(gl.calls().filter((c) => c.includes("/retry"))).toEqual([
    `POST /projects/grp%2Fweb/pipelines/${pl.id}/retry`,
  ]);
  // The retry ran again and failed again: now it counts, and no second retry is made.
  pl.jobs[0]!.status = "failed";
  const again = await ciHandler.step(cx, m);
  expect(again).toEqual({ done: expect.objectContaining({ event: "red", why: "CI failed: test" }) });
  expect(gl.calls().filter((c) => c.includes("/retry"))).toHaveLength(1);
});

test("gitlab ci: a first cancelled pipeline is retried once", async () => {
  const { gl, mr, forge } = setup();
  const pl = gl.pipeline(mr, [["test", "canceled"]]);
  const m = mission(mr);
  const cx = ctx(forge, ticking());
  expect(await ciHandler.step(cx, m)).toEqual({ poll: 5 });
  expect(gl.calls().filter((c) => c.includes("/retry"))).toHaveLength(1);
  pl.jobs[0]!.status = "canceled";
  // Cancelled again: the existing rule lets it settle once more before it counts as red.
  expect(await ciHandler.step(cx, m)).toEqual({ poll: 5 });
  expect(gl.calls().filter((c) => c.includes("/retry"))).toHaveLength(1);
});

test("gitlab ci: a failing job's log tail goes to the repair round", async () => {
  const { gl, mr, forge } = setup();
  const pl = gl.pipeline(mr, [
    ["test", "failed", { trace: "running tests\nError: a test failed\n" }],
    ["lint", "failed", { allow_failure: true, trace: "lint noise only" }],
  ]);
  const m = mission(mr);
  const cx = ctx(forge, ticking());
  await ciHandler.step(cx, m);
  for (const j of pl.jobs) j.status = "failed";
  const red = await ciHandler.step(cx, m);
  const repair =
    "done" in red ? (red.done.data as { repair: { kind: string; details: string } }).repair : null;
  expect(repair?.kind).toBe("ci");
  expect(repair?.details).toContain("Job test:\nrunning tests\nError: a test failed");
  expect(repair?.details).not.toContain("lint noise only");
  expect(m.ci_repairs).toBe(0);
  expect("done" in red && red.done.set).toEqual({ ci_repairs: 1 });
});

test("gitlab ci: log tails are cut and redacted", async () => {
  const { gl, mr, forge } = setup();
  const noise = Array.from({ length: 2000 }, (_, i) => `line ${i} of a long log`).join("\n");
  const trace = `first line\n${noise}\n  Secret: hunter2-token\nError: the last failure\n`;
  const pl = gl.pipeline(mr, [["test", "failed", { trace }]]);
  const m = mission(mr);
  const cx = ctx(forge, ticking());
  await ciHandler.step(cx, m);
  pl.jobs[0]!.status = "failed";
  const red = await ciHandler.step(cx, m);
  const details = "done" in red ? (red.done.data as { repair: { details: string } }).repair.details : "";
  expect(details).toContain("Error: the last failure");
  expect(details).not.toContain("hunter2-token");
  expect(details).not.toContain("first line");
  expect(details.length).toBeLessThan(LOG_TAIL + 500);
});

test("gitlab ci: a refused retry waits with the reason", async () => {
  const { gl, mr, forge } = setup();
  gl.pipeline(mr, [["test", "failed"]]);
  gl.retryRefusal = "Retry is not allowed on this pipeline";
  const m = mission(mr);
  const out = await ciHandler.step(
    ctx(forge, () => PUSHED + 1000),
    m,
  );
  expect(out).toEqual({
    done: expect.objectContaining({
      event: "wait",
      waiting: "CI red",
      why: "Retry is not allowed on this pipeline",
    }),
  });
});
