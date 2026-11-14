// PIP-228, PIP-229, PIP-233: the proof depends on the kind: a bugfix is proven red→green without spec IDs,
// a refactor by its existing tests staying as they are, and an infra change runs no red→green proof.

import { expect, test } from "vitest";
import { build, happy, intent, intents, PLAN, reply, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

function world(kind: string, edits: Record<string, string>): Pipe {
  const p = new Pipe(TARGET, intents(intent({ a: 5, extra: `kind: ${kind}\n` })), { keep: true });
  happy(p);
  if (kind === "infra")
    p.respond.plan = reply({ ...PLAN, apply: [{ command: "true", why: "nothing to change" }] });
  p.respond.worker = () => ({ structured: build(), edits });
  return p;
}

test("pipeline: a refactor passes with the existing tests untouched", async () => {
  const p = world("refactor", { "greeting.txt": "hello\n", "tests/new.sh": "true\n" });
  try {
    await p.start();
    const m = await p.untilStage("done");
    expect(JSON.parse(m.data).proof).toBe("Refactor: no existing test changed");
    expect(p.sandboxRuns.filter((r) => r.kind === "proof")).toHaveLength(0);
  } finally {
    p.cleanup();
  }
}, 120_000);

test("pipeline: the refactor PR says no test changed", async () => {
  const p = world("refactor", { "greeting.txt": "hello\n" });
  try {
    await p.start();
    const m = await p.untilStage("done");
    expect(p.prNo("web", m.pr!).body).toContain("Refactor: no existing test changed");
  } finally {
    p.cleanup();
  }
}, 120_000);

test("pipeline: an infra mission runs no red-green proof", async () => {
  const p = world("infra", { "greeting.txt": "hello\n" });
  try {
    await p.start();
    const m = await p.untilStage("done");
    expect(JSON.parse(m.data).proof).toBe("none needed");
    expect(p.sandboxRuns.filter((r) => r.kind === "proof")).toHaveLength(0);
  } finally {
    p.cleanup();
  }
}, 120_000);

test("pipeline: a bugfix without spec IDs still needs a failing test", async () => {
  const p = world("bugfix", { "greeting.txt": "hello\n", "tests/always.sh": "true\n" });
  try {
    await p.start();
    const m = await p.untilStage("blocked");
    expect(m.waiting).not.toBeNull();
    expect(p.sandboxRuns.filter((r) => r.kind === "proof").length).toBeGreaterThan(0);
  } finally {
    p.cleanup();
  }
}, 120_000);

test("pipeline: a refactor that edits an existing test is asked first", async () => {
  const p = world("refactor", { "greeting.txt": "hello\n", "tests/base.sh": "true # touched\n" });
  try {
    await p.start();
    const m = await p.untilStage("blocked");
    expect(p.moves()).not.toContain("→ publish");
    expect(m.waiting).not.toBeNull();
  } finally {
    p.cleanup();
  }
}, 120_000);
