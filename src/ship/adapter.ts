// The deploy adapter (SHIP-3, 4, 5): what is live, whether a commit went live, and a request for an
// older version. Towercab never deploys and never reaches a server; it only asks.

import { homedir } from "node:os";
import { git } from "../checkout.ts";
import { ForgeDenied } from "../forge.ts";
import { type Ctx, EnvError } from "../handlers.ts";
import type { Mission } from "../mission.ts";
import { checksMayWrite, commandDomains } from "../pipeline/checks.ts";
import { viaForge } from "../pipeline/common.ts";
import { splitDomains } from "../pipeline/domains.ts";
import { proxySocket } from "../pipeline/proxy.ts";
import { cacheEnv, sandboxArgv, sandboxEnv } from "../pipeline/sandbox.ts";
import type { RunResult } from "../tools.ts";
import { type Live, liveDomains, shipNetwork } from "./live.ts";
import type { Secrets } from "./secrets.ts";

export type DeployOutcome = { state: "live" } | { state: "failed"; why: string } | { state: "pending" };

export interface RollbackAsk {
  sha: string;
  /** The broken commit. */
  from: string;
  reason: string;
  intent: string;
  /** Unix s the step was recorded: a Deployment made after it is this request's. */
  since: number;
}

export interface Adapter {
  /** The commit live in the environment now, or null. */
  current(): Promise<string | null>;
  outcome(sha: string): Promise<DeployOutcome>;
  /** Ask for `sha`; returns the request's id when the platform has one. */
  rollback(ask: RollbackAsk): Promise<number | null>;
}

/** Where the adapter runs: the mission's repo and checkout, the live block, the secrets. */
export interface AdapterEnv {
  cx: Ctx;
  m: Mission;
  live: Live;
  secrets: Secrets;
  /** Towercab's clone of the repo, for the contains check. */
  clone: string;
  /** The checkout the command adapter runs in. */
  dir: string;
}

export const COMMAND_TIMEOUT_MS = 5 * 60_000;

export function adapterOf(e: AdapterEnv): Adapter {
  return e.live.adapter === "command" ? commandAdapter(e) : githubAdapter(e);
}

/** Whether `newer` is `sha` or contains it, in Towercab's clone after a fetch. */
async function contains(e: AdapterEnv, newer: string, sha: string): Promise<boolean> {
  if (newer === sha) return true;
  const repo = e.cx.repo(e.m);
  await git(e.cx.tools, e.clone, ["fetch", "--quiet", "origin"], await e.cx.github.gitAuth(repo.github));
  const r = await e.cx.tools.run("git", ["-C", e.clone, "merge-base", "--is-ancestor", sha, newer]);
  return r.code === 0;
}

function githubAdapter(e: AdapterEnv): Adapter {
  const github = e.cx.repo(e.m).github;
  const list = (sha?: string) => viaForge(e.cx.github.listDeployments(github, e.live.environment, sha));
  const latest = (id: number) => viaForge(e.cx.github.deploymentStatus(github, id));
  const current = async () => {
    for (const d of await list()) if ((await latest(d.id))?.state === "success") return d.sha;
    return null;
  };
  return {
    current,
    async outcome(sha) {
      const mine = await list(sha);
      const newest = mine[0] ? await latest(mine[0].id) : null;
      if (newest?.state === "success") return { state: "live" };
      if (newest?.state === "failure" || newest?.state === "error")
        return { state: "failed", why: newest.description || newest.state };
      const now = await current();
      if (now && now !== sha && (await contains(e, now, sha))) return { state: "live" };
      return { state: "pending" };
    },
    async rollback(ask) {
      // A request this step already made (a crash after the POST) is reused, never made twice.
      for (const d of await list(ask.sha)) {
        const p = d.payload as { intent?: string } | null;
        if (
          d.task === "deploy:rollback" &&
          p?.intent === ask.intent &&
          Date.parse(d.createdAt) / 1000 >= ask.since - 1
        )
          return d.id;
      }
      const body = {
        ref: ask.sha,
        environment: e.live.environment,
        task: "deploy:rollback",
        auto_merge: false,
        required_contexts: [],
        description: `Towercab: roll back ${ask.from.slice(0, 7)} for ${ask.intent}`.slice(0, 140),
        payload: { intent: ask.intent, from: ask.from, reason: ask.reason.slice(0, 500) },
      };
      try {
        return await e.cx.github.createDeployment(github, body);
      } catch (err) {
        if (err instanceof ForgeDenied)
          throw new RollbackRefused("Towercab's GitHub App needs read and write access to Deployments");
        throw new EnvError("github", (err as Error).message);
      }
    },
  };
}

function commandAdapter(e: AdapterEnv): Adapter {
  const current = async () => {
    const r = await runCommand(e, e.live.liveCommand!, {});
    if (r.code !== 0) return null;
    return /\b[0-9a-f]{40}\b/.exec(r.stdout)?.[0] ?? null;
  };
  return {
    current,
    async outcome(sha) {
      const now = await current();
      return now && (await contains(e, now, sha)) ? { state: "live" } : { state: "pending" };
    },
    async rollback(ask) {
      const r = await runCommand(e, e.live.rollbackCommand!, {
        TOWERCAB_ROLLBACK_SHA: ask.sha,
        TOWERCAB_REASON: ask.reason,
      });
      if (r.code !== 0) {
        const out = e.secrets.redact(`${r.stdout}${r.stderr}`).trim().split("\n").slice(-3).join(" ");
        throw new RollbackRefused(
          `the rollback command ${r.timedOut ? "timed out" : `exited ${r.code}`}${out ? `: ${out}` : ""}`,
        );
      }
      return null;
    },
  };
}

/** The platform refused or failed a rollback request: the rollback failed (SHIP-10). */
export class RollbackRefused extends Error {}

/** The env every repo command of the ship stage gets (SHIP-5, SHIP-9). */
export function shipEnv(e: { live: Live; secrets: Secrets }, sha: string): Record<string, string> {
  return {
    ...e.secrets.env,
    BASE_URL: e.live.url,
    TOWERCAB_ENVIRONMENT: e.live.environment,
    TOWERCAB_SHA: sha,
  };
}

/** One adapter command in the sandbox with network, the secrets and the ship env (SHIP-5). */
async function runCommand(e: AdapterEnv, line: string, extra: Record<string, string>): Promise<RunResult> {
  const repo = e.cx.repo(e.m);
  const cache = e.cx.home.cache(repo.name);
  const home = homedir();
  const argv = sandboxArgv({
    checkout: e.dir,
    home,
    cache,
    proxy: proxySocket(
      [
        ...commandDomains(e.m),
        ...splitDomains([...liveDomains(e.live), ...shipNetwork(e.cx.db, repo.name)]).valid,
      ],
      (l) => e.cx.log(l),
    ),
    cacheWritable: checksMayWrite(e.cx, e.m),
    line,
  });
  const sha = (await e.cx.tools.run("git", ["-C", e.dir, "rev-parse", "HEAD"])).stdout.trim();
  return e.cx.tools.run(argv[0]!, argv.slice(1), {
    cwd: e.dir,
    env: {
      ...sandboxEnv(home, e.cx.config, cacheEnv(cache, repo, home)),
      ...shipEnv(e, sha),
      ...extra,
    },
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
}
