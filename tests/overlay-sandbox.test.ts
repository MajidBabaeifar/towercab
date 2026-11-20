// REPO-43: the overlay lives outside every checkout and sandbox, so a worker cannot write it.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { type ClaudeRun, claudeArgv, claudeSettings } from "../src/claude.ts";
import { tempDir, testConfig } from "./helpers/world.ts";

function run(file: string): ClaudeRun {
  return {
    kind: "worker",
    model: "opus",
    cwd: "/h/work/261001-0900-1",
    runsDir: "/h/runs/261001-0900",
    n: 1,
    prompt: "do it",
    session: { mode: "none", id: "" },
    claudeMd: "# Base rules\n",
    grants: { domains: [], paths: [], open: false },
    cacheEnv: {},
    config: testConfig({ agent: { path: "/usr/bin:/bin" } }, file),
  };
}

test("repo: the overlay is not mounted in the sandbox", () => {
  const cfg = tempDir("tc-cfg-");
  const file = join(cfg, "config.toml");
  const overlay = join(cfg, "repos");
  const settings = (r: ClaudeRun) =>
    claudeSettings(r, { towercabExe: "/opt/towercab/bin/towercab", home: "/home/me" }) as {
      sandbox: { filesystem: { denyRead: string[]; denyWrite: string[]; allowWrite?: string[] } };
    };
  // Without an overlay there is nothing to name.
  expect(settings(run(file)).sandbox.filesystem.denyRead).not.toContain(overlay);
  mkdirSync(join(overlay, "web"), { recursive: true });
  const fs = settings(run(file)).sandbox.filesystem;
  expect(fs.denyRead).toContain(overlay);
  expect(fs.denyWrite).toContain(overlay);
  // Never writable: not among the allowed writes either.
  expect(fs.allowWrite ?? []).not.toContain(overlay);
  // The worker's own tools may not read it either, wherever `--config` put it.
  const argv = claudeArgv(run(file));
  expect(argv).toContain(`Read(/${overlay.replace(/^\//, "")}/**)`);
});
