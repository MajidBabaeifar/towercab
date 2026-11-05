// Merge (PIP-22): a PR behind its base gets the base merged in and goes back to CI; a conflicting one
// goes back to the worker for a conflict round; Towercab merges only the head that passed the gate.

import { afterAll, beforeAll, expect, test } from "vitest";
import type { Mission } from "../../src/mission.ts";
import { mergeStateWhy } from "../../src/pipeline/gate.ts";
import { build, happy, ID, intent, intents, reply, SLUG, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";
import { git } from "../helpers/world.ts";

let p: Pipe;
let m: Mission;
const BRANCH = `towercab/${ID}-${SLUG}`;
const gates = () =>
  p.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM transitions WHERE to_stage = 'gate'")!.n;

const README = `${Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;

beforeAll(async () => {
  p = new Pipe({ ...TARGET, "README.md": README }, intents(intent({ a: 5 })), { keep: true });
  happy(p);
  // The test checks the greeting's text, so base's own greeting.txt (below) doesn't pass it; the
  // change also edits README's last line.
  p.queue(
    "worker",
    reply(build(), {
      "greeting.txt": "hello\n",
      "tests/greeting.sh": "grep -q hello greeting.txt\n",
      "README.md": README.replace("line 10", "line 10, with a greeting"),
    }),
  );
  await p.start();
  await p.until(() => gates() === 1);
  // GitHub will say BEHIND: main moved on (lines added at README's top, which shifts the diff's line
  // numbers but not what it changes), then DIRTY (a conflicting greeting).
  p.pushTo("web", "main", { "README.md": `# Web\n\nThe site.\n\n${README}` });
  p.prNo("web", p.mission()!.pr!).mergeStates.push("BEHIND", "DIRTY");
  await p.until(() => gates() === 2);
  p.pushTo("web", "main", { "greeting.txt": "hi\n" });
  p.queue("worker", reply(build(), { "greeting.txt": "hello, hi\n" }));
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
  expect(p.show("web", BRANCH, "README.md")).toMatch(
    /^# Web\n\nThe site\.\n\nline 1\n[\s\S]*line 10, with a greeting\n$/,
  );
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
  expect(p.show("web", "main", "greeting.txt")).toBe("hello, hi\n");
  expect(p.show("web", "main", "README.md")).toContain("The site.");
});

test("pipeline: merge on the gated head", () => {
  // Each merge attempt read the PR first; the only merge call names the head the last gate passed.
  const merges = p.tools.lines("gh").filter((l) => l.startsWith(`pr merge ${m.pr} `));
  expect(merges).toEqual([`pr merge ${m.pr} --squash --match-head-commit ${m.head} -R owner/web`]);
  expect(m.head).toBe(p.headSha("owner/web", BRANCH));
  expect(gates()).toBe(3);
});

test("pipeline: review reused for an unchanged diff", () => {
  const reviews = moves().filter((t) => t.from_stage === "review");
  // After the update, the same change at other line numbers: the review stands. After the conflict
  // round, the change is different: a new review, its own round.
  expect(reviews.map((t) => t.why)).toEqual([null, "the diff is unchanged: the review stands", null]);
  expect(p.claudeCalls.filter((c) => c.kind === "review")).toHaveLength(2);
  // The risk check stands with it (PIP-96): one at the spec, one at the plan, one per reviewed diff.
  expect(p.claudeCalls.filter((c) => c.kind === "risk")).toHaveLength(4);
  const comments = p.prNo("web", m.pr!).comments.map((c) => c.body.split("\n")[0]);
  expect(comments).toEqual(["<!-- towercab:review:1 -->", "<!-- towercab:review:2 -->"]);
});

test("pipeline: GitHub's merge state in plain words", () => {
  // PIP-110: each state says what the owner can do, never GitHub's bare word.
  expect(mergeStateWhy("BLOCKED")).toMatch(
    /^GitHub won't merge it yet: a required check or review is missing\./,
  );
  expect(mergeStateWhy("UNSTABLE")).toMatch(
    /some checks fail or haven't finished\. Look at the failing checks/,
  );
  expect(mergeStateWhy("BEHIND")).toBe(
    "The PR is behind its base branch. Update the branch on GitHub, then merge it.",
  );
  expect(mergeStateWhy("DIRTY")).toMatch(/^The PR clashes with changes on its base branch\./);
  expect(mergeStateWhy("DRAFT")).toMatch(/still a draft/);
  expect(mergeStateWhy("HAS_HOOKS")).toMatch(
    /^GitHub won't merge it yet \(it says "has_hooks"\)\. Check the PR's merge box/,
  );
});
