// The clone fetch belongs to the pass; only reads run in the background (LOOP-71, REPO-23): a hung read
// ends at the limit without holding the pass, a hung fetch holds the pass at most that long, and the
// ci release is read without touching the clone.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Loop } from "../src/loop.ts";
import { refreshReadiness, storedReadiness } from "../src/readiness.ts";
import type { ChildSpec, RunOpts } from "../src/tools.ts";
import { TARGET } from "./helpers/flows.ts";
import { Pipe } from "./helpers/pipe.ts";
import { release, rig, WEB } from "./helpers/ready.ts";
import { okResult } from "./helpers/tools.ts";
import { git } from "./helpers/world.ts";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.GIT_CONFIG_GLOBAL;
});
afterEach(() => {
  if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = saved;
});

/** A loop whose tools hang on the calls `hang` matches; everything else is the real fake. */
async function hangingLoop(hang: (cmd: string, args: string[], opts?: RunOpts) => boolean, limit = 400) {
  const p = new Pipe(TARGET, {});
  await p.start({}, {});
  const real = p.loop.d.tools;
  const seen: string[] = [];
  const tools = {
    run: (cmd: string, args: string[], opts?: RunOpts) => {
      if (cmd === "git" && opts?.cwd?.includes("/repos/")) {
        seen.push(args.filter((a) => !a.startsWith("-") && !a.startsWith("core.")).join(" "));
      }
      return hang(cmd, args, opts) ? new Promise<never>(() => {}) : real.run(cmd, args, opts);
    },
    spawn: (spec: ChildSpec) => real.spawn(spec),
    which: (cmd: string) => real.which(cmd),
  };
  const loop = new Loop({ ...p.loop.d, tools, readiness: true, readinessLimitMs: limit }, { watch: true });
  await loop.open();
  return { p, loop, seen };
}

test("readiness: a hung read ends at the limit and the pass does not wait for it", async () => {
  const { p, loop } = await hangingLoop((cmd, args) => cmd === "git" && args.includes("ls-tree"));
  const started = Date.now();
  await loop.pass();
  expect(Date.now() - started).toBeLessThan(300);
  const state = await Promise.race([
    loop.readinessIdle().then(() => "done"),
    new Promise((r) => setTimeout(() => r("running"), 30)),
  ]);
  expect(state).toBe("running");
  await loop.readinessIdle();
  expect(p.logs.some((l) => l.includes("timed out"))).toBe(true);
  expect(storedReadiness(p.db, "web")).toBeNull();
});

test("readiness: the clone is fetched in the pass, never beside the background reads", async () => {
  const { loop, seen } = await hangingLoop(() => false, 5_000);
  await loop.pass();
  const fetches = seen.filter((l) => l.startsWith("fetch")).length;
  expect(fetches).toBeGreaterThan(0);
  await loop.readinessIdle();
  expect(seen.filter((l) => l.startsWith("fetch")).length).toBe(fetches);
  expect(seen.some((l) => l.startsWith("ls-tree"))).toBe(true);
});

test("readiness: a hung fetch holds the pass until the limit, then waits ten minutes", async () => {
  const { p, loop } = await hangingLoop((cmd, args) => cmd === "git" && args.includes("fetch"), 300);
  await loop.pass();
  expect(p.logs.some((l) => l.includes("timed out"))).toBe(true);
  expect(storedReadiness(p.db, "web")).toBeNull();
  expect(Number(p.db.meta("readiness-failed:web"))).toBeGreaterThan(0);
  const before = p.logs.filter((l) => l.includes("timed out")).length;
  await loop.pass();
  expect(p.logs.filter((l) => l.includes("timed out")).length).toBe(before);
});

test("readiness: the ci release is read without touching the clone and runs with the App's token only", async () => {
  const r = rig({ web: WEB, ci: { "README.md": "ci\n" } });
  release(r.remotes.ci!, { "bin/apply-settings": "#!/bin/sh\n# 1\n" }, "v1.0.0");
  await refreshReadiness(r.deps, r.config.repos.get("ci")!, true);
  const clone = join(r.home, "repos", "ci");
  const head = () => git(clone, "status", "--porcelain=v1") + git(clone, "worktree", "list");
  const before = head();
  const script = join(r.home, "tmp", "ci-settings-v1.0.0", "bin", "apply-settings");
  let env: Record<string, string> = {};
  r.tools.on(script, (_args, opts) => {
    env = opts.env ?? {};
    return okResult();
  });
  process.env.SECRET_FOR_TEST = "x";
  await refreshReadiness(r.deps, r.config.repos.get("web")!, true);
  delete process.env.SECRET_FOR_TEST;
  // The clone has no new worktree, no staged files and no private index left behind.
  expect(head()).toBe(before);
  expect(existsSync(`${script}.index`)).toBe(false);
  // The script saw an explicit App token and a small environment, not the loop's.
  expect(env.GH_TOKEN).toBe("app");
  expect(Object.keys(env).sort()).toEqual(["GH_PROMPT_DISABLED", "GH_TOKEN", "HOME", "NO_COLOR", "PATH"]);
  // ci is fetched once per cycle: the second repo's check did not fetch it again.
  const fetchesOfCi = r.tools.calls.filter(
    (c) => c.cmd === "git" && c.args.includes("fetch") && c.opts.cwd === clone,
  ).length;
  expect(fetchesOfCi).toBe(1);
});
