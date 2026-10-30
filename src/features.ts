// The feature list's backfill (INT-39): a read-only Claude run over a fresh checkout of a repo's base
// branch reads its README and specs and writes what people can already do, as the list's live lines.
// It runs outside any mission, once per repo when the Repos page first shows it, and again on
// "Refresh from the repo". Its state is a `features:<repo>` meta row.

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentBudgetUsd, agentTimeoutMin, loadAgent } from "./agents.ts";
import { ensureClone, freshCheckout, removeCheckout } from "./checkout.ts";
import { type ClaudeRun, parseRun, prepareRun, runEndLine } from "./claude.ts";
import { type Config, clonePath } from "./config.ts";
import type { Db } from "./db.ts";
import type { Clock, GitHub } from "./handlers.ts";
import type { Home } from "./home.ts";
import { cleanSentence, featuresPath, parseFeatures, replaceLive } from "./intents/features.ts";
import type { IntentStore } from "./intents/types.ts";
import { fence, render } from "./pipeline/prompts.ts";
import { parseResult, SCHEMAS } from "./pipeline/schemas.ts";
import { checkoutRoot } from "./service.ts";
import type { Tools } from "./tools.ts";

/** At most this many sentences are kept from a run (INT-39). */
export const MAX_FEATURES = 30;

/** INT-39: where a repo's backfill stands, kept in meta `features:<repo>`. */
export interface FeaturesRun {
  /** `due`: asked for, not started; `running`; `done`; `failed`. */
  state: "due" | "running" | "done" | "failed";
  /** Unix seconds of the last change. */
  at: number;
  /** `failed`: why, in one line. */
  why?: string;
  /** `done`: how many sentences it wrote. */
  n?: number;
  /** `done` or `failed` after a run: what the run cost. */
  cost?: number;
}

const KEY = "features:";

export function featuresRun(db: Db, repo: string): FeaturesRun | null {
  const raw = db.meta(`${KEY}${repo}`);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as FeaturesRun;
    return v && typeof v === "object" && typeof v.state === "string" ? v : null;
  } catch {
    return null;
  }
}

export function setFeaturesRun(db: Db, repo: string, r: FeaturesRun): void {
  db.setMeta(`${KEY}${repo}`, JSON.stringify(r));
}

/**
 * UI-144: ask for a backfill of `repo`; the loop starts it when new work may start. False when one is
 * already asked for or running. The meta row is the request: the page and the loop share the process.
 */
export function askFeatures(db: Db, repo: string, now: number): boolean {
  const s = featuresRun(db, repo)?.state;
  if (s === "due" || s === "running") return false;
  setFeaturesRun(db, repo, { state: "due", at: now });
  return true;
}

/** Repos whose backfill is asked for and not started, oldest ask first. */
export function dueFeatures(db: Db): string[] {
  return db
    .all<{ key: string }>("SELECT key FROM meta WHERE key LIKE 'features:%' ORDER BY key")
    .map((r) => r.key.slice(KEY.length))
    .map((repo) => ({ repo, run: featuresRun(db, repo) }))
    .filter((x) => x.run?.state === "due")
    .sort((a, b) => a.run!.at - b.run!.at)
    .map((x) => x.repo);
}

/** A run a stopped loop left `running` is asked for again (LOOP-7's recovery for this side job). */
export function recoverFeatures(db: Db, now: number): void {
  for (const r of db.all<{ key: string }>("SELECT key FROM meta WHERE key LIKE 'features:%'")) {
    const repo = r.key.slice(KEY.length);
    if (featuresRun(db, repo)?.state === "running") setFeaturesRun(db, repo, { state: "due", at: now });
  }
}

export interface FeaturesDeps {
  config: Config;
  home: Home;
  tools: Tools;
  clock: Clock;
  store: IntentStore;
  github: Pick<GitHub, "gitAuth">;
  /** Default: this checkout's `bin/towercab`. */
  towercabExe?: string;
  /** The user's HOME. Default: `os.homedir()`. */
  userHome?: string;
  /** Resolves when Towercab stops: the run is killed and the backfill throws `StoppedError`. */
  stop?: Promise<void>;
}

/** Why a backfill failed, with what its run cost when it got that far. */
export class BackfillError extends Error {
  readonly cost: number;
  constructor(message: string, cost = 0) {
    super(message);
    this.cost = cost;
  }
}

/** The backfill was cut short by Towercab stopping; it is asked for again. */
export class StoppedError extends Error {}

const read = (p: string) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};

/**
 * INT-39: one backfill of `repoName`'s feature list. Resolves with the sentences written and the run's
 * cost; a failure throws a `BackfillError` whose message is the reason.
 */
export async function backfillFeatures(
  d: FeaturesDeps,
  repoName: string,
): Promise<{ n: number; cost: number }> {
  const repo = d.config.repos.get(repoName);
  if (!repo) throw new BackfillError(`${repoName} isn't a repo Towercab knows`);
  const clone = clonePath(repo, d.home.root);
  try {
    await ensureClone(d.tools, clone, repo, await d.github.gitAuth(repo.github));
  } catch (e) {
    throw new BackfillError(`fetching ${repo.github} failed: ${(e as Error).message}`);
  }
  const checkout = d.home.abs(join("work", `features-${repoName}`));
  await freshCheckout(d.tools, clone, checkout, repo.base, "towercab/features");
  try {
    const current = await d.store.readFile(featuresPath(repoName));
    const live = parseFeatures(current)
      .filter((f) => f.status === "live" && f.intent === null)
      .map((f) => `- ${f.text}`);
    const runsDir = d.home.runs("features", repoName);
    const n = readdirSync(runsDir).filter((f) => /^features-\d+\.prompt$/.test(f)).length + 1;
    const agent = loadAgent("features");
    const run: ClaudeRun = {
      kind: "features",
      agent: "features",
      model: d.config.agent.model,
      cwd: checkout,
      runsDir,
      n,
      prompt: render("features", {
        repo: repoName,
        current: fence(live.length ? live.join("\n") : "(none yet)", "current"),
      }),
      schema: SCHEMAS.features,
      session: { mode: "none", id: "" },
      budgetUsd: agentBudgetUsd(agent, d.config),
      claudeMd: "",
      grants: { domains: [], paths: [], open: false },
      cacheEnv: {},
      config: d.config,
    };
    const home = d.userHome ?? homedir();
    const spec = {
      ...prepareRun(run, { towercabExe: d.towercabExe ?? join(checkoutRoot(), "bin", "towercab"), home }),
      slot: false,
    };
    const handle = d.tools.spawn(spec);
    let timer: NodeJS.Timeout | undefined;
    const end = await Promise.race([
      handle.done,
      new Promise<"timeout">((r) => {
        timer = setTimeout(() => r("timeout"), (agentTimeoutMin(agent, d.config) * 60 + 10) * 1000);
        timer.unref();
      }),
      ...(d.stop ? [d.stop.then(() => "stopped" as const)] : []),
    ]);
    clearTimeout(timer);
    if (end === "stopped") {
      handle.kill("SIGKILL");
      throw new StoppedError("Towercab stopped");
    }
    if (end === "timeout") {
      handle.kill("SIGKILL");
      throw new BackfillError("the run took longer than its time limit");
    }
    const r = parseRun(read(spec.stdout), read(spec.stderr), end.code, {
      model: d.config.agent.model,
      now: new Date(d.clock.now() * 1000),
      home,
    });
    const cost = "result" in r && r.result ? r.result.costUsd : 0;
    if (r.kind !== "ok") throw new BackfillError(`the run ended badly (${runEndLine(r)})`, cost);
    // The model's answer is data: checked against the schema, then each sentence cleaned to one line.
    const parsed = parseResult("features", r.result.structuredOutput);
    if (!parsed.ok) throw new BackfillError(`its answer doesn't fit the schema: ${parsed.why}`, cost);
    const seen = new Set<string>();
    const sentences: string[] = [];
    for (const s of parsed.value.features) {
      const c = cleanSentence(s);
      if (!c || seen.has(c.toLowerCase())) continue;
      seen.add(c.toLowerCase());
      sentences.push(c);
    }
    if (!sentences.length) throw new BackfillError("its answer has no usable sentence", cost);
    const kept = sentences.slice(0, MAX_FEATURES);
    await d.store.editFeatures(repoName, "backfill", (t) => replaceLive(t, repoName, kept));
    return { n: kept.length, cost };
  } finally {
    removeCheckout(checkout);
  }
}
