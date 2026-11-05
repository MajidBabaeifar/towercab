// The readiness review's five points: a closed proposal is a no, setup PRs count from anywhere, the settings
// check runs from a pinned ci release, the check lives off the pass with one deadline, and the page links
// the proposal.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { ProposedPr } from "../src/github/proposed.ts";
import { Loop } from "../src/loop.ts";
import {
  proposeSetup,
  READINESS_EVERY_S,
  readinessCycle,
  refreshReadiness,
  setupAttemptDue,
  storedReadiness,
  withDeadline,
} from "../src/readiness.ts";
import type { ChildSpec, RunOpts } from "../src/tools.ts";
import { TARGET } from "./helpers/flows.ts";
import { Pipe } from "./helpers/pipe.ts";
import { release, rig, WEB } from "./helpers/ready.ts";
import { okResult } from "./helpers/tools.ts";
import { listing } from "./intents/fixtures.ts";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.GIT_CONFIG_GLOBAL;
});
afterEach(() => {
  if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = saved;
});

const DAY = 86_400;
type Rig = ReturnType<typeof rig>;
const cycle = (r: Rig, proposed: ProposedPr[] | null = []) =>
  readinessCycle(r.deps, { listing: () => listing([]), proposed: () => proposed });
const later = (r: Rig, s: number) => r.clock.advance(s);
const RELEASE_FILES = {
  "release-please-config.json": "{}",
  ".release-please-manifest.json": "{}",
  ".github/workflows/release.yml": "uses: googleapis/release-please-action@v4\n",
};

/** A proposed PR that adds a setup intent for `repo`, opened by someone else. */
function setupPr(repo: string): ProposedPr {
  return {
    number: 31,
    url: "https://github.com/owner/intents/pull/31",
    title: "Intent: fix the setup",
    draft: false,
    proposer: "majid",
    createdAt: 1,
    head: "a".repeat(40),
    path: "intents/261101-0900-x/intent.md",
    intent: { title: "Fix the setup", repo, u: 4, i: 4, a: null, source: "agent", setup: true },
    textUrl: null,
    acceptable: true,
    reason: null,
  };
}

test("readiness: a closed proposal is not proposed again until the missing items change", async () => {
  const r = rig({ web: WEB });
  expect(await cycle(r)).toBe("web");
  expect(r.prs).toHaveLength(1);
  // The owner closes it. The check runs again later and finds the same gaps: a no stays a no.
  r.ghPrs.value = JSON.stringify([{ number: 7, state: "CLOSED", author: { login: "app/towercab" } }]);
  later(r, READINESS_EVERY_S + 1);
  await cycle(r);
  later(r, 3 * DAY);
  await cycle(r);
  expect(r.prs).toHaveLength(1);
  // A new set of missing items is a new question.
  release(r.remotes.web!, RELEASE_FILES);
  later(r, READINESS_EVERY_S + 1);
  await cycle(r);
  expect(r.prs).toHaveLength(2);
});

test("readiness: at most one proposal per repo per day", async () => {
  const r = rig({ web: WEB });
  await cycle(r);
  expect(r.prs).toHaveLength(1);
  r.ghPrs.value = JSON.stringify([{ number: 7, state: "CLOSED", author: { login: "app/towercab" } }]);
  // The items change within the day: not proposed yet, and tried again once the day has passed.
  release(r.remotes.web!, RELEASE_FILES);
  later(r, READINESS_EVERY_S + 1);
  await cycle(r);
  expect(r.prs).toHaveLength(1);
  const stored = storedReadiness(r.db, "web")!.readiness;
  expect(setupAttemptDue(r.db, "web", stored, r.clock.now())).toBe(false);
  later(r, DAY);
  await cycle(r);
  expect(r.prs).toHaveLength(2);
});

test("readiness: a setup PR from the proposed list counts as open", async () => {
  const r = rig({ web: WEB });
  const web = r.config.repos.get("web")!;
  await refreshReadiness(r.deps, web);
  const gaps = storedReadiness(r.db, "web")!.readiness;
  // Opened by the standards review (or anyone): Towercab opens none.
  expect(await proposeSetup(r.deps, web, gaps, listing([]), [setupPr("web")])).toBe(false);
  expect(r.prs).toHaveLength(0);
  // A setup PR for another repo doesn't count; the one opened carries the repo's mark in its body.
  expect(await proposeSetup(r.deps, web, gaps, listing([]), [setupPr("api")])).toBe(true);
  expect(r.prs[0]?.body).toContain("<!-- towercab:setup repo=web -->");
});

test("readiness: nothing is proposed while the proposed intents are unknown", async () => {
  const r = rig({ web: WEB });
  await cycle(r, null);
  expect(storedReadiness(r.db, "web")).not.toBeNull();
  expect(r.prs).toHaveLength(0);
  later(r, READINESS_EVERY_S + 1);
  await cycle(r, []);
  expect(r.prs).toHaveLength(1);
});

const SCRIPT = "#!/bin/sh\n";

test("readiness: settings run from the latest v* tag of ci", async () => {
  const r = rig({ web: WEB, ci: { "README.md": "ci\n" } });
  const logs: string[] = [];
  r.deps.log = (l) => logs.push(l);
  release(r.remotes.ci!, { "bin/apply-settings": `${SCRIPT}# 1.2\n` }, "v1.2.0");
  release(r.remotes.ci!, { "bin/apply-settings": `${SCRIPT}# 1.10\n` }, "v1.10.0");
  // Main moves on without the script, and a later tag is not a release: only v* tags count, newest first.
  release(r.remotes.ci!, { "bin/apply-settings": null }, "nightly");
  await refreshReadiness(r.deps, r.config.repos.get("ci")!, true);
  const tree = join(r.home, "tmp", "ci-settings-v1.10.0");
  const script = join(tree, "bin", "apply-settings");
  const ran: string[] = [];
  r.tools.on(script, (args) => {
    ran.push(`${script} ${args.join(" ")}`);
    return okResult();
  });
  await refreshReadiness(r.deps, r.config.repos.get("web")!, true);
  expect(ran).toEqual([`${script} --check owner/web`]);
  expect(logs.some((l) => l.includes("from ci v1.10.0"))).toBe(true);
  expect(storedReadiness(r.db, "web")!.readiness.items.find((i) => i.item === "settings")?.state).toBe(
    "present",
  );
  expect(existsSync(tree)).toBe(false);
});

test("readiness: settings without a ci release are unknown", async () => {
  const r = rig({ web: WEB, ci: { "bin/apply-settings": SCRIPT } });
  await refreshReadiness(r.deps, r.config.repos.get("ci")!, true);
  await refreshReadiness(r.deps, r.config.repos.get("web")!, true);
  const settings = storedReadiness(r.db, "web")!.readiness.items.find((i) => i.item === "settings")!;
  expect(settings).toMatchObject({
    state: "unknown",
    words: "The standard settings could not be checked: the ci repo has no v* release yet",
  });
  expect(r.tools.calls.some((c) => c.cmd.endsWith("apply-settings"))).toBe(false);
});

test("readiness: the check has one deadline for the fetch and the reads", async () => {
  const r = rig({ web: WEB });
  r.deps.limitMs = 5_000;
  await refreshReadiness(r.deps, r.config.repos.get("web")!, true);
  const timeouts = r.tools.calls
    .filter((c) => c.cmd === "git" || c.cmd === "gh")
    .map((c) => c.opts.timeoutMs);
  expect(timeouts.length).toBeGreaterThan(5);
  expect(timeouts.every((t) => t !== undefined && t <= 5_000)).toBe(true);
  const scope = withDeadline(r.deps, 5_000);
  scope.abort();
  await expect(scope.tools.run("git", ["status"])).rejects.toThrow("timed out");
  await expect(scope.github.gh("owner/web", ["api", "x"])).rejects.toThrow("timed out");
  let t = 0;
  const clock = withDeadline(r.deps, 100, () => t);
  t = 101;
  await expect(clock.tools.run("git", ["status"])).rejects.toThrow("timed out");
});

test("readiness: a hung check ends at the limit and the pass does not wait for it", async () => {
  const p = new Pipe(TARGET, {});
  await p.start({}, {});
  // A fetch that never answers: the check hangs until its deadline.
  const real = p.loop.d.tools;
  const tools = {
    run: (cmd: string, args: string[], opts?: RunOpts) =>
      cmd === "git" && args.includes("fetch") && opts?.cwd?.includes("/repos/")
        ? new Promise<never>(() => {})
        : real.run(cmd, args, opts),
    spawn: (spec: ChildSpec) => real.spawn(spec),
    which: (cmd: string) => real.which(cmd),
  };
  const loop = new Loop({ ...p.loop.d, tools, readiness: true, readinessLimitMs: 400 }, { watch: true });
  await loop.open();
  const started = Date.now();
  await loop.pass();
  // The pass came back at once with the check still running in the background.
  expect(Date.now() - started).toBeLessThan(300);
  const state = await Promise.race([
    loop.readinessIdle().then(() => "done"),
    new Promise((r) => setTimeout(() => r("running"), 30)),
  ]);
  expect(state).toBe("running");
  // At the limit it ends, logs why, and keeps nothing half-written.
  await loop.readinessIdle();
  expect(p.logs.some((l) => l.includes("timed out"))).toBe(true);
  expect(storedReadiness(p.db, "web")).toBeNull();
});
