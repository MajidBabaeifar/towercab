// Merge (PIP-22): a PR behind its base gets the base merged in and goes back to CI; a conflicting one
// goes back to the worker for a conflict round; Towercab merges only the head that passed the gate.

import { afterAll, beforeAll, expect, test } from "vitest";
import type { Mission } from "../../src/mission.ts";
import { build, happy, ID, intent, intents, reply, SLUG, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";
import { git } from "../helpers/world.ts";

let p: Pipe;
let m: Mission;
const BRANCH = `towercab/${ID}-${SLUG}`;
const gates = () =>
  p.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM transitions WHERE to_stage = 'gate'")!.n;

beforeAll(async () => {
  p = new Pipe(TARGET, intents(intent({ a: 5 })), { keep: true });
  happy(p);
  // The test checks the greeting's text, so base's own greeting.txt (below) doesn't pass it.
  p.queue(
    "worker",
    reply(build(), { "greeting.txt": "hello\n", "tests/greeting.sh": "grep -q hello greeting.txt\n" }),
  );
  await p.start();
  await p.until(() => gates() === 1);
  // GitHub will say BEHIND: main moved on (an unrelated change), then DIRTY (a conflicting one).
  p.pushTo("web", "main", { "README.md": "web, now with docs\n" });
  p.prNo("web", p.mission()!.pr!).mergeStates.push("BEHIND", "DIRTY");
  await p.until(() => gates() === 2);
  p.pushTo("web", "main", { "greeting.txt": "hi\n" });
  p.queue("worker", reply(build(), { "greeting.txt": "hello\n" }));
  await p.until(() => p.mission()?.stage === "done");
  m = p.mission()!;
}, 60_000);

afterAll(() => p.cleanup());

const moves = () =>
  p.db.all<{ from_stage: string; event: string; to_stage: string; why: string | null }>(
    "SELECT from_stage, event, to_stage, why FROM transitions ORDER BY id",
  );

test("pipeline: behind updates the branch", () => {
  expect(m.stage, p.moves()).toBe("done");
  const put = p.tools.lines("gh").filter((l) => l.includes("/update-branch"));
  expect(put).toHaveLength(1);
  expect(put[0]).toMatch(
    new RegExp(`^api -X PUT repos/owner/web/pulls/${m.pr}/update-branch -f expected_head_sha=[0-9a-f]{40}$`),
  );
  expect(moves()).toContainEqual({
    from_stage: "merge",
    event: "head_moved",
    to_stage: "ci",
    why: "updated the branch with its base",
  });
  // The base's change reached the PR's branch, and the merge GitHub made stays in its history: the
  // checkout took the new head, so later rounds build on it instead of pushing over it.
  expect(p.show("web", BRANCH, "README.md")).toBe("web, now with docs\n");
  expect(p.updates).toHaveLength(1);
  git(p.bares.web!, "merge-base", "--is-ancestor", p.updates[0]!, BRANCH);
});

test("pipeline: dirty is a conflict round", () => {
  expect(moves()).toContainEqual({
    from_stage: "merge",
    event: "conflict",
    to_stage: "build",
    why: "the PR conflicts with its base",
  });
  const w = p.claudeCalls.filter((c) => c.kind === "worker");
  expect(w).toHaveLength(2);
  expect(w[1]!.prompt).toMatch(/^Merging the base branch conflicts\./);
  expect(w[1]!.prompt).toContain("greeting.txt");
  expect(w[1]!.session).toEqual({ mode: "resume", id: m.session });
  // The resolution is a merge of base into the branch, pushed to the same PR, then merged.
  const parents = git(p.bares.web!, "log", "-1", "--format=%P", BRANCH).trim().split(" ");
  expect(parents).toHaveLength(2);
  expect(p.prs.filter((x) => x.head === BRANCH)).toHaveLength(1);
  expect(p.show("web", "main", "greeting.txt")).toBe("hello\n");
  expect(p.show("web", "main", "README.md")).toBe("web, now with docs\n");
});

test("pipeline: merge on the gated head", () => {
  // Each merge attempt read the PR first; the only merge call names the head the last gate passed.
  const merges = p.tools.lines("gh").filter((l) => l.startsWith(`pr merge ${m.pr} `));
  expect(merges).toEqual([`pr merge ${m.pr} -R owner/web --squash --match-head-commit ${m.head}`]);
  expect(m.head).toBe(p.headSha("owner/web", BRANCH));
  expect(gates()).toBe(3);
});
