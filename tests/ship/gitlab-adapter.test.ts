// The gitlab adapter (SHIP-37, SHIP-38): what GitLab recorded for the environment, and a rollback that
// retries the project's own deploy job. FakeGitLab serves the deployments; no network.

import { expect, test } from "vitest";
import { GitLabForge } from "../../src/forge/gitlab.ts";
import type { Ctx } from "../../src/handlers.ts";
import type { Mission } from "../../src/mission.ts";
import { dataOf } from "../../src/mission.ts";
import { deployProgress } from "../../src/pipeline/ship.ts";
import { parseRepoFiles, RepoError } from "../../src/repo/files.ts";
import { type Adapter, adapterOf, RollbackRefused } from "../../src/ship/adapter.ts";
import { parseLive } from "../../src/ship/live.ts";
import { secretsOf } from "../../src/ship/secrets.ts";
import { FakeGitLab, gitlabConfig } from "../helpers/gitlab.ts";
import { FakeTools, failResult, okResult } from "../helpers/tools.ts";
import { testDb } from "../helpers/world.ts";

const SLUG = "gitlab:g/web";
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const SINCE = Date.parse("2026-11-05T12:00:00Z") / 1000;

const suites = [
  new Map<string, unknown>([
    ["name", "s"],
    ["command", "x"],
    ["tests", ["x"]],
  ]),
];

function liveBlock(extra: [string, unknown][] = []) {
  return parseLive(new Map<string, unknown>([["url", "https://a.dev"], ["suites", suites], ...extra]));
}

/** An adapter on a fake GitLab with project g/web; `contained` answers `git merge-base --is-ancestor`. */
function world(o: { contained?: boolean } = {}): { gl: FakeGitLab; adapter: Adapter; tools: FakeTools } {
  const gl = new FakeGitLab();
  gl.project("g/web");
  const forge = new GitLabForge(gitlabConfig().cfg, gl.http);
  const tools = new FakeTools();
  tools.on("git", (args) =>
    args.includes("merge-base") ? (o.contained ? okResult() : failResult("", 1)) : okResult(),
  );
  const adapter = adapterOf({
    cx: {
      repo: () => ({ github: SLUG }),
      tools,
      github: { gitAuth: async () => ({ args: [], env: {} }) },
    } as unknown as Ctx,
    m: {} as Mission,
    live: liveBlock([
      ["adapter", "gitlab"],
      ["environment", "production"],
    ]),
    secrets: secretsOf({}),
    clone: "/c",
    dir: "/d",
    gitlab: forge,
  });
  return { gl, adapter, tools };
}

const ask = (sha: string) => ({ sha, from: C, reason: "e2e red", intent: "261104-0001", since: SINCE });

test("ship: gitlab adapter reads deployments", async () => {
  const { gl, adapter } = world();
  expect(await adapter.current()).toBeNull();
  gl.deploy("production", A, "success", { created_at: "2026-11-05T09:00:00Z" });
  gl.deploy("staging", C, "success");
  gl.deploy("production", B, "failed");
  expect(await adapter.current()).toBe(A);
  const asked = gl.requests.at(-1)!.path;
  expect(asked).toContain("/deployments?environment=production&order_by=id&sort=desc");
  // A success of the sha is live; a newer success that contains it is live too; otherwise pending.
  expect(await adapter.outcome(A)).toEqual({ state: "live" });
  expect(await adapter.outcome(C)).toEqual({ state: "pending" });
  expect(gl.calls().some((c) => c.startsWith("POST"))).toBe(false);
  const contained = world({ contained: true });
  contained.gl.deploy("production", A, "success");
  expect(await contained.adapter.outcome(B)).toEqual({ state: "live" });
});

test("ship: a failed gitlab deploy reports the job's reason", async () => {
  const { gl, adapter } = world();
  gl.deploy("production", A, "failed", { failure_reason: "script_failure" });
  gl.deploy("production", B, "failed");
  expect(await adapter.outcome(A)).toEqual({ state: "failed", why: "script_failure" });
  expect(await adapter.outcome(B)).toEqual({ state: "failed", why: "the deploy job failed" });
});

test("ship: gitlab adapter retries the deploy job once", async () => {
  const { gl, adapter } = world();
  const good = gl.deploy("production", A, "success", { created_at: "2026-11-05T09:00:00Z" });
  gl.deploy("production", B, "failed", { created_at: "2026-11-05T09:30:00Z" });
  gl.retryAt = "2026-11-05T12:00:05Z";
  const job = await adapter.rollback(ask(A));
  expect(gl.jobRetries).toEqual([good.job.id]);
  const retried = gl.deploys.find((d) => d.job.id === job)!;
  expect(retried).toMatchObject({ sha: A, environment: "production" });
  // The step runs again after a crash: the retry made after `since` is reused.
  expect(await adapter.rollback(ask(A))).toBe(job);
  expect(gl.jobRetries).toHaveLength(1);
  await expect(adapter.rollback(ask(C))).rejects.toThrow(
    "no successful deployment of ccccccc in production to run again",
  );
  const fresh = world();
  fresh.gl.deploy("production", A, "success");
  fresh.gl.jobRefusal = { status: 403, message: "403 Forbidden" };
  await expect(fresh.adapter.rollback(ask(A))).rejects.toThrow(
    "Towercab's GitLab token needs permission to run jobs in the production environment",
  );
  fresh.gl.jobRefusal = { status: 400, message: "Job is outdated: Prevent outdated deployment jobs" };
  const err = await fresh.adapter.rollback(ask(A)).catch((e) => e);
  expect(err).toBeInstanceOf(RollbackRefused);
  expect(err.message).toContain("Prevent outdated deployment jobs is on");
  expect(err.message).toContain("turn it off for the production environment");
});

const claude = "# R\n\n## Verifying your work\n\n```checks\nmake\n```\n";
const towercab = (adapter?: string) =>
  `---\nlive:\n  url: https://a.dev\n${adapter ? `  adapter: ${adapter}\n` : ""}  suites:\n    - {name: s, command: x, tests: [x]}\n---\n`;

test("ship: gitlab is the default adapter of a GitLab repo", () => {
  expect(parseRepoFiles(claude, null, towercab(), SLUG).towercab.live?.adapter).toBe("gitlab");
  expect(parseRepoFiles(claude, null, towercab("gitlab"), SLUG).towercab.live?.adapter).toBe("gitlab");
  expect(parseRepoFiles(claude, null, towercab(), "owner/web").towercab.live?.adapter).toBe("github");
  expect(parseRepoFiles(claude, null, towercab(), undefined).towercab.live?.adapter).toBe("github");
  const cmd = "  live_command: ./l\n  rollback_command: ./r\n";
  const c = towercab("command").replace("  suites:", `${cmd}  suites:`);
  expect(parseRepoFiles(claude, null, c, SLUG).towercab.live?.adapter).toBe("command");
});

test("ship: gitlab adapter on a GitHub repo is invalid", () => {
  const why = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return e instanceof RepoError ? e.message : String(e);
    }
    return "";
  };
  expect(why(() => parseRepoFiles(claude, null, towercab("gitlab"), "owner/web"))).toContain(
    "live: the gitlab adapter is for GitLab repos",
  );
  expect(why(() => parseRepoFiles(claude, null, towercab("github"), SLUG))).toContain(
    "live: the github adapter is for GitHub repos",
  );
});

const APPROVAL = "the deploy is waiting for approval: a person has to approve it in GitLab (production)";

test("ship: a gitlab deploy waiting for approval is pending with the reason", async () => {
  const { gl, adapter } = world();
  gl.deploy("production", A, "blocked");
  expect(await adapter.outcome(A)).toEqual({ state: "pending", why: APPROVAL });
  // Nothing is approved by Towercab: only reads.
  expect(gl.calls().every((c) => c.startsWith("GET"))).toBe(true);
});

/** The deploy step's reaction to an answer, on a stub context. */
function step(now: number, since: number, pending?: { why: string; at: number }) {
  const db = testDb();
  let ship = { merges: [A], fixes: 0, since, ...(pending ? { pending } : {}) };
  const m = () =>
    ({ id: 7, intent: "261104-0001", repo: "web", step: "wait", data: JSON.stringify({ ship }) }) as Mission;
  const cx = {
    db,
    clock: { now: () => now, mono: () => now },
    config: { agent: { ciPoll: 5 } },
    record: (cur: Mission, _s: string, _set: unknown, d: { ship: typeof ship }) => {
      ship = d.ship;
      return { ...cur, data: JSON.stringify({ ship }) } as Mission;
    },
  } as unknown as Ctx;
  const live = liveBlock([["timeout", 20]]);
  const run = (o: Parameters<typeof deployProgress>[4]) => deployProgress(cx, m(), { live, ship }, A, o);
  return { db, run, ship: () => ship };
}

test("ship: a gitlab deploy never approved times out with the reason", () => {
  const sent = (db: ReturnType<typeof testDb>) =>
    db.all<{ key: string; text: string }>("SELECT key, text FROM outbox");
  const t = SINCE;
  const early = step(t + 60, t);
  expect(early.run({ state: "pending", why: APPROVAL })).toEqual({ poll: 5 });
  expect(dataOf({ data: JSON.stringify({ ship: early.ship() }) } as Mission)).toMatchObject({
    ship: { pending: { why: APPROVAL, at: t + 60 } },
  });
  expect(sent(early.db)).toEqual([]);
  // Five minutes in, the owner is told once, with the reason.
  const later = step(t + 6 * 60, t, { why: APPROVAL, at: t + 60 });
  later.run({ state: "pending", why: APPROVAL });
  later.run({ state: "pending", why: APPROVAL });
  expect(sent(later.db)).toEqual([{ key: `deploy-pending:7:${t}`, text: `${APPROVAL}\n261104-0001 (web)` }]);
  // Unapproved after the timeout: red, with the same reason.
  const out = step(t + 21 * 60, t, { why: APPROVAL, at: t + 60 }).run({ state: "pending", why: APPROVAL });
  expect(out).toMatchObject({
    done: { event: "red", why: `not live after 20 minutes: ${APPROVAL}` },
  });
  // Without a reason the red is as before.
  expect(step(t + 21 * 60, t).run({ state: "pending" })).toMatchObject({
    done: { event: "red", why: "not live after 20 minutes" },
  });
});
