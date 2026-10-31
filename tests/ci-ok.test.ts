// The `ci-ok` job of Towercab's CI (PIP-90) passes only when every job it needs passed or was skipped.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parse } from "yaml";

const ci = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
const script: string = ci.jobs["ci-ok"].steps.map((s: { run?: string }) => s.run ?? "").join("\n");

// The workflow runs the script with `bash -e`, with the needed jobs' results in RESULTS.
const exitCode = (results: string) =>
  spawnSync("bash", ["-e", "-c", script], {
    env: { PATH: process.env.PATH, RESULTS: results },
    stdio: "ignore",
  }).status;

test("ci-ok: passes when every needed job succeeded or was skipped", () => {
  expect(exitCode("success success success success")).toBe(0);
  expect(exitCode("success skipped success success")).toBe(0);
});

test("ci-ok: fails when a needed job failed, was cancelled or has no result", () => {
  expect(exitCode("success failure success success")).toBe(1);
  expect(exitCode("cancelled success success success")).toBe(1);
  expect(exitCode("success success success neutral")).toBe(1);
});
