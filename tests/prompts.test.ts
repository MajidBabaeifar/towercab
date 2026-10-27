// The writing guide (PIP-39): one guide, appended to every run's system file.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { prepareRun, RUN_KINDS, WRITING_GUIDE } from "../src/claude.ts";
import { tempDir, testConfig } from "./helpers/world.ts";

test("prompts: writing guide is in every run", () => {
  const guide = readFileSync(WRITING_GUIDE, "utf8");
  // What it covers (PIP-39).
  for (const part of [
    "## Who reads it",
    "## Lead with the outcome",
    "## No internal jargon",
    "## Asking a question",
    "## A pull request description",
    "## A spec requirement",
  ]) {
    expect(guide).toContain(part);
  }
  const lines = guide.trimEnd().split("\n").length;
  expect(lines).toBeGreaterThanOrEqual(80);
  expect(lines).toBeLessThanOrEqual(130);

  const root = tempDir();
  const runsDir = join(root, "runs");
  for (const kind of RUN_KINDS) {
    const spec = prepareRun(
      {
        kind,
        model: "opus",
        cwd: root,
        runsDir,
        n: 1,
        prompt: "x",
        session: { mode: "none", id: "" },
        claudeMd: "# Base rules\n\nUse tabs.\n",
        grants: { domains: [], paths: [], open: false },
        cacheEnv: {},
        config: testConfig(),
      },
      { towercabExe: "towercab", home: "/home/me" },
    );
    const file = spec.argv[spec.argv.indexOf("--append-system-prompt-file") + 1]!;
    expect(file).toBe(join(runsDir, `system-${kind}.md`));
    // The base branch's CLAUDE.md first, then the guide whole.
    expect(readFileSync(file, "utf8")).toBe(`# Base rules\n\nUse tabs.\n\n${guide}`);
  }
  // Without a CLAUDE.md: the guide alone.
  const spec = prepareRun(
    {
      kind: "review",
      model: "opus",
      cwd: root,
      runsDir,
      n: 2,
      prompt: "x",
      session: { mode: "new", id: "u" },
      claudeMd: "",
      grants: { domains: [], paths: [], open: false },
      cacheEnv: {},
      config: testConfig(),
    },
    { towercabExe: "towercab", home: "/home/me" },
  );
  expect(readFileSync(spec.argv[spec.argv.indexOf("--append-system-prompt-file") + 1]!, "utf8")).toBe(guide);
});
