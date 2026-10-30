// Run files by stage (LOOP-39 to LOOP-42): where a Claude run writes, how rounds are named, and how
// readers and old flat runs find them.

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { type ClaudeRun, prepareRun, runFiles } from "../src/claude.ts";
import { Home } from "../src/home.ts";
import { flatStage } from "../src/ui/state.ts";
import { tempDir, testConfig } from "./helpers/world.ts";

const config = testConfig({ agent: { path: "/usr/bin:/bin" } }, "/cfg/config.toml");
const O = { towercabExe: "/opt/towercab/bin/towercab", home: "/home/me" };

function worker(root: string, over: Partial<ClaudeRun> = {}): ClaudeRun {
  const checkout = join(root, "work");
  mkdirSync(checkout, { recursive: true });
  return {
    kind: "worker",
    model: "opus",
    cwd: checkout,
    runsDir: join(root, "runs", "261001-0900"),
    stage: "build",
    n: 1,
    prompt: "do it",
    session: { mode: "none", id: "" },
    claudeMd: "# Base rules\n",
    grants: { domains: [], paths: [], open: false },
    cacheEnv: {},
    guardRules: { checkout, protected: [], granted: [], locked: [] },
    config,
    ...over,
  };
}

test("runs: files land in the stage folder", () => {
  const root = tempDir();
  const run = worker(root);
  const spec = prepareRun(run, O);
  const stage = join(run.runsDir, "build");
  expect(readdirSync(stage).sort()).toEqual([
    "guard.json",
    "settings-worker.json",
    "system-worker.md",
    "worker-1.prompt",
  ]);
  // Nothing sits beside the stage folder.
  expect(readdirSync(run.runsDir)).toEqual(["build"]);
  expect(spec).toMatchObject({
    stdin: join(stage, "worker-1.prompt"),
    stdout: join(stage, "worker-1.json"),
    stderr: join(stage, "worker-1.err"),
  });
  const hook = JSON.parse(readFileSync(join(stage, "settings-worker.json"), "utf8")).hooks.PreToolUse[0]
    .hooks[0];
  expect(hook.command).toContain(join(stage, "guard.json"));
  // A stage folder of the home's own: `Home.runs(id, stage)` makes it.
  const home = new Home(join(root, "home"));
  expect(home.runs("261001-0900", "verify")).toBe(join(home.root, "runs", "261001-0900", "verify"));
  expect(existsSync(join(home.root, "runs", "261001-0900", "verify"))).toBe(true);
});

test("runs: rounds keep separate files", () => {
  const root = tempDir();
  const first = worker(root, { n: 1, prompt: "round one" });
  const second = worker(root, { n: 2, prompt: "round two" });
  prepareRun(first, O);
  prepareRun(second, O);
  const a = runFiles(first);
  const b = runFiles(second);
  expect(a.prompt).not.toBe(b.prompt);
  expect(a.stdout).not.toBe(b.stdout);
  expect(readFileSync(a.prompt, "utf8")).toBe("round one");
  expect(readFileSync(b.prompt, "utf8")).toBe("round two");
});

test("runs: flat runs are assigned to stages by prefix", () => {
  const stages: Record<string, string> = {
    "design-1.prompt": "design",
    "plan-1.json": "plan",
    "worker-2.json": "build",
    "worker-1.err": "build",
    "build-setup.log": "build",
    "verify-1.log": "verify",
    "verify-1-setup.log": "verify",
    "shots-1.log": "verify",
    "shots-1": "verify",
    "proof.log": "proof",
    "proof-head.log": "proof",
    "review-1.json": "review",
    "settings-worker.json": "build",
    "system-design.md": "design",
    "settings-review.json": "review",
    "guard.json": "build",
    "score-1.prompt": "other",
    "notes.txt": "other",
  };
  for (const [name, stage] of Object.entries(stages)) expect(flatStage(name), name).toBe(stage);
});
