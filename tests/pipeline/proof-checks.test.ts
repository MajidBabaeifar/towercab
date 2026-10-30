// Which checks block the proof runs (PIP-54): the PR's `CLAUDE.md` when the PR changes it and may, run
// red on base and then green on the PR's head; otherwise the base's.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { Mission } from "../../src/mission.ts";
import { build, CLAUDE_MD, happy, intent, intents, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

/** The target's `CLAUDE.md` with one more line in its checks block. */
const withLine = (line: string) => CLAUDE_MD.replace("\n```\n", `\n${line}\n\`\`\`\n`);

/** A script for every worker round: the change plus a `round`-dependent file, so each round differs. */
function worker(p: Pipe, files: Record<string, string>): void {
  let round = 0;
  p.respond.worker = () => {
    round++;
    return { structured: build(), edits: { ...files, "greeting.txt": `hello ${round}\n` } };
  };
}

const proofRuns = (p: Pipe, kind: string) => p.sandboxRuns.filter((r) => r.kind === kind);
const script = (r: { argv: string[] }) => r.argv.join("\n");

/** The owner merges the spec and plan PRs a mission waits on (a4 needs them). */
function ownerMerges(p: Pipe): void {
  for (const m of p.db.all<Mission>("SELECT * FROM missions WHERE stage LIKE 'approval:%' AND step = ''")) {
    const [repo, n] =
      m.stage === "approval:spec"
        ? ["web", m.spec_pr]
        : m.stage === "approval:plan"
          ? ["intents", m.plan_pr]
          : ["web", null];
    if (n === null) continue;
    const pr = p.prNo(repo!, n);
    if (pr.state === "OPEN") p.mergePr(pr);
  }
}

test("pipeline: proof uses the PR's checks block when CLAUDE.md is granted", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  happy(p);
  // The base's block never runs tests/sub; only the PR's new line fails on base and passes on the branch.
  worker(p, {
    "tests/sub/check.sh": "test -f greeting.txt\n",
    "CLAUDE.md": withLine("sh tests/sub/check.sh"),
  });
  await p.start();
  await p.until(() => p.stages(p.mission()!.id).includes("publish"));
  const m = p.mission()!;
  expect(p.stages(m.id), p.moves()).toContain("publish");
  expect(JSON.parse(m.data)).toMatchObject({ proof: "proven" });
  expect(JSON.parse(m.data).unproven).toBeUndefined();
  expect(m.repairs).toBe(0);
  const [base] = proofRuns(p, "proof");
  const [head] = proofRuns(p, "proof-head");
  expect(proofRuns(p, "proof")).toHaveLength(1);
  expect(proofRuns(p, "proof-head")).toHaveLength(1);
  expect(script(base!)).toContain("sh tests/sub/check.sh");
  expect(base!.cwd.endsWith("-proof")).toBe(true);
  // The same lines run on the PR's head, in the mission's own checkout.
  expect(script(head!)).toContain("sh tests/sub/check.sh");
  expect(head!.cwd.endsWith("-proof")).toBe(false);
}, 30_000);

test("pipeline: proof keeps the base's checks block when CLAUDE.md is not granted", async () => {
  // At a4 a protected path is writable only when the plan grants it, and this plan grants none.
  const p = new Pipe(TARGET, intents(intent({ a: 4 })));
  happy(p);
  worker(p, {
    "tests/sub/check.sh": "test -f greeting.txt\n",
    "CLAUDE.md": withLine("sh tests/sub/check.sh"),
  });
  await p.start();
  await p.until(() => {
    ownerMerges(p);
    return p.mission()?.waiting === "tests don't prove the change";
  });
  const m = p.mission()!;
  expect([m.waiting, m.why], p.moves()).toEqual([
    "tests don't prove the change",
    "The PR's tests pass without the change, so they don't prove it.",
  ]);
  // The base's block runs `tests/*.sh` only, so it is green on base; the PR's line never ran.
  const proofs = proofRuns(p, "proof");
  expect(proofs).toHaveLength(3);
  for (const r of proofs) expect(script(r)).not.toContain("tests/sub/check.sh");
  expect(proofRuns(p, "proof-head")).toHaveLength(0);
}, 30_000);

test("pipeline: proof falls back to the base's checks block when the PR's does not parse", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  happy(p);
  // No checks block in the PR's file; tests/greeting.sh fails on base under the base's block.
  worker(p, {
    "tests/greeting.sh": "test -f greeting.txt\n",
    "CLAUDE.md": "# Web\n\n## Verifying your work\n\nNothing here.\n",
  });
  await p.start();
  await p.until(() => p.stages(p.mission()!.id).includes("publish"));
  const m = p.mission()!;
  expect(JSON.parse(m.data), p.moves()).toMatchObject({ proof: "proven" });
  expect(proofRuns(p, "proof")).toHaveLength(1);
  expect(proofRuns(p, "proof-head")).toHaveLength(0);
  const log = readFileSync(join(p.home.runs(m.intent, "proof"), "proof.log"), "utf8");
  expect(log).toContain("CLAUDE.md in the PR doesn't parse");
  expect(log).toContain("using the base's checks");
  expect(log.indexOf("using the base's checks")).toBeLessThan(log.indexOf("tests/*.sh"));
}, 30_000);

test("pipeline: proof needs the PR's checks block green on head", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  happy(p);
  // `false` is red on base and red on the branch: it proves nothing.
  worker(p, {
    "tests/greeting.sh": "test -f greeting.txt\n",
    "CLAUDE.md": withLine("false"),
  });
  await p.start();
  const m = await p.untilStage("blocked");
  expect([m.waiting, m.why], p.moves()).toEqual([
    "checks red",
    "The checks block your change adds to CLAUDE.md fails on your branch.",
  ]);
  // The owner's "go on" can't wave a failing block through: no unproven flag, no data.proofWaited.
  expect(m.data).not.toContain("proofWaited");
  const d = JSON.parse(m.data);
  expect(d.unproven).toBeUndefined();
  expect(d.proof).not.toBe("proven");
  expect(proofRuns(p, "proof")).toHaveLength(3);
  expect(proofRuns(p, "proof-head")).toHaveLength(3);
  const reds = p.db.all<{ from_stage: string; to_stage: string }>(
    "SELECT from_stage, to_stage FROM transitions WHERE event = 'red' AND from_stage = 'proof' ORDER BY id",
  );
  expect(reds).toEqual([
    { from_stage: "proof", to_stage: "build" },
    { from_stage: "proof", to_stage: "build" },
  ]);
  const repairs = p.claudeCalls.filter((c) => c.kind === "worker").slice(1);
  expect(repairs).toHaveLength(2);
  for (const r of repairs) expect(r.prompt).toMatch(/^The checks block your change adds to CLAUDE\.md fails/);
  expect(m.pr).toBeNull();
}, 30_000);
