// Setting up checks with several repos (REPO-36): one repo's open PR or failing draft never holds up another's.

import { expect, test } from "vitest";
import type { IntentStore } from "../src/intents/types.ts";
import {
  getSetup,
  MAX_ERRORS,
  putSetup,
  type SetupDeps,
  setupChecksPass,
  startSetup,
} from "../src/setup-checks.ts";
import { FakeForge } from "./helpers/fake-forge.ts";
import { serve } from "./helpers/ready.ts";
import { FakeTools, okResult } from "./helpers/tools.ts";
import { bareRepo, TestClock, testConfig, testDb, testHome } from "./helpers/world.ts";

const STATIC = { "index.html": "<html><body><p>hi</p></body></html>" };

function two() {
  const bares = { aaa: bareRepo(STATIC), bbb: bareRepo(STATIC) };
  serve(bares);
  const forge = new FakeForge();
  const tools = new FakeTools();
  tools.present.add("python3");
  tools.on("bwrap", () => okResult("ok"));
  const clock = new TestClock();
  const db = testDb();
  const config = testConfig({ repos: { aaa: { github: "owner/aaa" }, bbb: { github: "owner/bbb" } } });
  const log: string[] = [];
  const deps: SetupDeps = {
    config,
    home: testHome(),
    db,
    tools,
    clock,
    store: { get: async () => ({ a: 5, source: "me" }) } as unknown as IntentStore,
    github: forge as unknown as SetupDeps["github"],
    log: (l) => log.push(l),
  };
  return { deps, forge, db, clock, config, tools, bares };
}

test("repo: an open setup PR does not hold up the next repo", async () => {
  const w = two();
  startSetup(w.db, w.config.repos.get("aaa")!);
  await setupChecksPass(w.deps); // aaa drafts, pushes, opens its PR
  expect(getSetup(w.db, "aaa")).toMatchObject({ state: "open" });
  startSetup(w.db, w.config.repos.get("bbb")!);
  // aaa was read a moment ago and is not due: the pass goes on to bbb.
  await setupChecksPass(w.deps);
  await setupChecksPass(w.deps);
  expect(getSetup(w.db, "aaa")).toMatchObject({ state: "open" });
  expect(getSetup(w.db, "bbb")).toMatchObject({ state: "open" });
  expect(w.forge.prs.map((p) => p.repo).sort()).toEqual(["owner/aaa", "owner/bbb"]);
});

test("repo: a setup that keeps failing to run ends in an ask and frees the next repo", async () => {
  const w = two();
  // aaa's clone can't be fetched: its remote is gone.
  w.tools.on("git", async (args, opts) => {
    if (opts.cwd?.includes("/aaa") && args.includes("fetch"))
      return { code: 128, stdout: "", stderr: "fatal: unreachable", timedOut: false };
    return (await import("../src/tools.ts")).realTools().run("git", args, opts);
  });
  startSetup(w.db, w.config.repos.get("aaa")!);
  startSetup(w.db, w.config.repos.get("bbb")!);
  await setupChecksPass(w.deps); // aaa errors and backs off
  expect(getSetup(w.db, "aaa")).toMatchObject({ state: "drafting", errors: 1 });
  await setupChecksPass(w.deps); // bbb goes ahead while aaa backs off
  expect(getSetup(w.db, "bbb")!.state).toBe("open");
  for (let i = 0; i < MAX_ERRORS; i++) {
    w.clock.advance(300);
    await setupChecksPass(w.deps);
  }
  expect(getSetup(w.db, "aaa")).toMatchObject({ state: "failed" });
  expect(getSetup(w.db, "aaa")!.lastFailure).toContain("unreachable");
  putSetup(w.db, "aaa", getSetup(w.db, "aaa")!);
});
