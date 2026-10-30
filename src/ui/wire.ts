// The running loop's sources for the page (UI-1): what the UI reads from the loop, and its actions.

import { join } from "node:path";
import type { Config } from "../config.ts";
import { fixFor } from "../faults.ts";
import { type GitHub, systemClock } from "../handlers.ts";
import type { Home } from "../home.ts";
import type { Intent } from "../intents/types.ts";
import type { Loop } from "../loop.ts";
import { isParked, pickOrder, priorityOf } from "../priority.ts";
import { addRepo } from "../repos.ts";
import { checkoutRoot } from "../service.ts";
import { version as gitVersion } from "../update.ts";
import { createActions } from "./actions.ts";
import { startUi, type UiServer } from "./server.ts";
import { budgetReached, type Problem, type Skip, type UiSources, type UpNext } from "./state.ts";

export const DIST = join(checkoutRoot(), "ui", "dist");

/** The picker's whole list with why each one waits, structured for the page (UI-61). */
export function upNextOf(loop: Loop): UpNext[] {
  const { listing } = loop.state();
  if (!listing) return [];
  const config = loop.d.config;
  const state = loop.pickState();
  const doneIds = listing.doneIds;
  return pickOrder(listing, 1)
    .filter((i) => !state.active.has(i.id))
    .map((i: Intent) => {
      const p = priorityOf(i);
      let skip: Skip | null = null;
      const blocker = i.after.find((a) => !doneIds.has(a));
      if (state.paused) skip = { kind: "paused" };
      else if (state.blocked) skip = { kind: "unreachable", what: state.blocked };
      else if (isParked(p, config.intents.cutoff)) skip = { kind: "parked" };
      else if (blocker) skip = { kind: "after", intent: blocker };
      else {
        const full = state.full.get(i.repo);
        if (full && !state.started?.has(i.id)) skip = { kind: "ahead", n: full.n, limit: full.ahead };
        const model = i.model ?? config.agent.model;
        const until = loop.cooldownUntil(model);
        if (!skip && until) skip = { kind: "cooling", model, until };
      }
      return { intent: i.id, priority: p, skip };
    });
}

export function problemsOf(loop: Loop): Problem[] {
  const now = loop.now;
  const out: Problem[] = loop.health.open().map((f) => ({
    title: `Towercab can't reach ${f.kind === "github" ? "GitHub" : f.kind === "claude" ? "Claude" : f.kind}`,
    detail: f.error,
    fix: fixFor(f.kind),
    since: f.since,
  }));
  if (budgetReached(loop.d.db, loop.d.config, now)) {
    out.push({
      title: "Today's budget is spent",
      fix: "Nothing new starts until midnight. Raise [agent].daily_budget_usd to go on today.",
    });
  }
  return out;
}

export function sourcesOf(loop: Loop, home: Home): UiSources {
  let version = { commit: "unknown", behind: null as number | null };
  void gitVersion({ tools: loop.d.tools, checkout: checkoutRoot() }).then((v) => {
    version = v;
  });
  return {
    db: loop.d.db,
    store: loop.d.store,
    config: loop.d.config,
    clock: loop.d.clock,
    home,
    running: true,
    paused: () => loop.d.db.meta("paused") === "1",
    problems: () => problemsOf(loop),
    version: () => version,
    upNext: () => upNextOf(loop),
    prUrl: (repo, n) => `https://github.com/${repo}/pull/${n}`,
    intentUrl: (i) => loop.d.store.url(i),
  };
}

export function startLoopUi(loop: Loop, config: Config, github: GitHub, home: Home): UiServer {
  return startUi({
    port: config.ui.port,
    sources: sourcesOf(loop, home),
    actions: createActions({
      db: loop.d.db,
      store: loop.d.store,
      config,
      clock: loop.d.clock,
      github,
      addRepo: (gh, name) =>
        addRepo(
          {
            db: loop.d.db,
            config,
            tools: loop.d.tools,
            github,
            home: home.root,
            now: loop.now,
            source: "ui",
          },
          gh,
          name,
        ),
    }),
    distDir: DIST,
    log: (l) => loop.d.log(`ui: ${l}`),
  });
}

/** UI-2: the page without a loop, read-only, with a banner. */
export async function serveReadOnly(
  config: Config,
  home: Home,
  db: import("../db.ts").Db,
  store: import("../intents/types.ts").IntentStore,
  tools: import("../tools.ts").Tools,
): Promise<UiServer> {
  let version = { commit: "unknown", behind: null as number | null };
  void gitVersion({ tools, checkout: checkoutRoot() }).then((v) => {
    version = v;
  });
  const server = startUi({
    port: config.ui.port,
    sources: {
      db,
      store,
      config,
      clock: systemClock,
      home,
      running: false,
      paused: () => db.meta("paused") === "1",
      problems: () => [],
      version: () => version,
      upNext: () => [],
      prUrl: (repo, n) => `https://github.com/${repo}/pull/${n}`,
      intentUrl: (i) => store.url(i),
    },
    actions: null,
    distDir: DIST,
    log: () => {},
  });
  await server.ready;
  return server;
}
