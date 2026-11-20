// PIP-229: an infra change is applied in the sandbox after the checks, and the results go in the code PR.

import { expect, test } from "vitest";
import { build, happy, intent, intents, PLAN, reply, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

const APPLY = [
  { command: "echo one", why: "first" },
  { command: "echo two", why: "second" },
];

function world(apply: unknown): Pipe {
  const p = new Pipe(TARGET, intents(intent({ a: 5, extra: "kind: infra\n" })), { keep: true });
  happy(p);
  p.respond.plan = reply({ ...PLAN, ...(apply === undefined ? {} : { apply }) });
  p.respond.worker = () => ({ structured: build(), edits: { "greeting.txt": "hello\n" } });
  return p;
}

test("pipeline: an infra plan needs apply commands", async () => {
  const p = world([]);
  try {
    await p.start();
    await p.until(() => p.moves().includes("bad_result"));
    expect(p.moves()).toContain("an infrastructure plan needs apply commands");
  } finally {
    p.cleanup();
  }
}, 120_000);

test("pipeline: apply runs after verify and is recorded in the PR", async () => {
  const p = world(APPLY);
  try {
    await p.start();
    const m = await p.untilStage("done");
    const runs = p.sandboxRuns.map((r) => r.kind);
    expect(runs.indexOf("apply")).toBeGreaterThan(runs.indexOf("checks"));
    expect(runs.filter((k) => k === "apply")).toHaveLength(2);
    const body = p.prNo("web", m.pr!).body;
    expect(body).toContain("## What was applied");
    expect(body).toContain("`echo one` (first)");
    expect(body).toContain("`echo two` (second)");
  } finally {
    p.cleanup();
  }
}, 120_000);

test("pipeline: apply stays inside the sandbox grants", async () => {
  const p = world(APPLY);
  try {
    await p.start();
    await p.untilStage("done");
    const apply = p.sandboxRuns.filter((r) => r.kind === "apply");
    expect(apply.length).toBeGreaterThan(0);
    const wrap = (argv: string[]) => argv.slice(0, argv.indexOf("--"));
    const checks = p.sandboxRuns.find((c) => c.kind === "checks")!;
    for (const r of apply) {
      expect(r.cwd).toBe(checks.cwd);
      expect(wrap(r.argv)).toEqual(wrap(checks.argv));
    }
  } finally {
    p.cleanup();
  }
}, 120_000);

test("pipeline: a failing apply is a repair round", async () => {
  const p = world([{ command: "exit 3", why: "always fails" }]);
  try {
    await p.start();
    await p.until(() => p.moves().includes("Applying `exit 3` failed"));
    expect(p.moves()).toContain("verify → build (red");
  } finally {
    p.cleanup();
  }
}, 120_000);
