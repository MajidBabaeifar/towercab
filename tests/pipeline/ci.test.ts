// CI that stays red (PIP-2, PIP-3, PIP-13, PIP-18): each new head's first red is rerun, then a repair
// round in the same worker session pushes to the same PR; after two repairs the owner is asked.

import { afterAll, beforeAll, expect, test } from "vitest";
import type { Mission } from "../../src/mission.ts";
import { build, CODE, checkRun, happy, ID, intent, intents, SLUG, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

let p: Pipe;
let m: Mission;
const runs = new Map<string, number>();

beforeAll(async () => {
  p = new Pipe(TARGET, intents(intent({ a: 5 })), { keep: true });
  happy(p);
  let round = 0;
  p.respond.worker = () => {
    round++;
    return {
      structured: build(),
      edits: round === 1 ? CODE : { "greeting.txt": `hello, try ${round}\n` },
    };
  };
  await p.start();
  // Every head the code PR gets is red, with its own Actions run.
  await p.until(() => {
    const code = p.prs.find((x) => x.head === `towercab/${ID}-${SLUG}`);
    if (code)
      code.checks = (_pr, head) => {
        if (!runs.has(head)) runs.set(head, 200 + runs.size);
        return [checkRun("test", "FAILURE", runs.get(head)!)];
      };
    return p.mission()?.stage === "blocked";
  });
  m = p.mission()!;
}, 60_000);

afterAll(() => p.cleanup());

test("pipeline: CI red repairs twice then waits", () => {
  expect([m.stage, m.waiting, m.why], p.moves()).toEqual(["blocked", "CI red", "test"]);
  const reds = p.db.all<{ from_stage: string; to_stage: string; why: string }>(
    "SELECT from_stage, to_stage, why FROM transitions WHERE event = 'red' ORDER BY id",
  );
  expect(reds).toEqual([
    { from_stage: "ci", to_stage: "build", why: "CI failed: test" },
    { from_stage: "ci", to_stage: "build", why: "CI failed: test" },
  ]);
  const repairs = p.claudeCalls.filter((c) => c.kind === "worker").slice(1);
  expect(repairs).toHaveLength(2);
  for (const r of repairs) {
    expect(r.prompt).toMatch(/^CI failed on the PR\./);
    expect(r.prompt).toContain("- test: failure https://github.com/owner/web/actions/runs/");
    expect(r.prompt).toContain("Error: a test failed");
  }
  expect(p.claudeCalls.some((c) => c.kind === "review")).toBe(false);
});

test("pipeline: red is rerun once", () => {
  // One rerun per head, before that head's red counts.
  expect(runs.size).toBe(3);
  expect(p.reruns).toEqual([...runs.values()]);
  expect(p.forge.calls.filter((l) => l.startsWith("rerun "))).toEqual(
    [...runs.values()].map((r) => `rerun owner/web ${r}`),
  );
});

test("pipeline: later rounds only push", () => {
  const code = p.prs.filter((x) => x.repo === "owner/web" && x.head === `towercab/${ID}-${SLUG}`);
  expect(code).toHaveLength(1);
  expect(
    p.forge.calls.filter((l) => l.startsWith("open owner/web#") && l.endsWith(` towercab/${ID}-${SLUG}`)),
  ).toHaveLength(1);
  expect(m.pr).toBe(code[0]!.number);
  // Three rounds, three heads, all on the same PR; the last is the mission's.
  expect(m.head).toBe([...runs.keys()][2]);
  expect(p.show("web", `towercab/${ID}-${SLUG}`, "greeting.txt")).toBe("hello, try 3\n");
  expect(p.stages(m.id).filter((s) => s === "publish")).toHaveLength(3);
});

test("pipeline: one session from design to repairs", () => {
  const worker = p.claudeCalls.filter((c) => c.kind !== "review" && c.kind !== "risk");
  expect(worker.map((c) => c.kind)).toEqual(["design", "plan", "worker", "worker", "worker"]);
  const id = m.session;
  expect(worker[0]!.session).toEqual({ mode: "new", id });
  for (const c of worker.slice(1)) expect(c.session).toEqual({ mode: "resume", id });
  // A repair's prompt is short: what failed and the log, fenced as data, not the plan again.
  const repair = worker[3]!.prompt;
  expect(repair).not.toContain("# Plan:");
  expect(repair).toContain("<log>");
  expect(worker.every((c) => c.cwd.endsWith(`work/${ID}-1`))).toBe(true);
});
