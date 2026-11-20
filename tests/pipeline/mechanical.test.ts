// A conflict where both sides only added is resolved by code, checked in full and reviewed as a merge
// alone, without a worker round (PIP-167, PIP-169).

import { afterAll, expect, test } from "vitest";
import type { Mission } from "../../src/mission.ts";
import { build, CODE, happy, intent, intents, REVIEW, reply, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";
import { git } from "../helpers/world.ts";

const SEED: Record<string, string> = {
  ...TARGET,
  "list.txt": "a\nb\n",
  "src/imports.ts": 'import { a } from "./x.ts";\n\nexport const v = [a];\n',
  "styles.css": ".a {\n  color: red;\n}\n\n.z {\n  top: 0;\n}\n",
  "docs/status.md": "**Status:** Live: WEB-1..5 · **Prefix:** WEB\n",
};

const rule = (name: string, prop: string) => `.${name} {\n  ${prop}: 1;\n}\n\n`;
const css = (rules: string) => `.a {\n  color: red;\n}\n\n${rules}.z {\n  top: 0;\n}\n`;

/** What the PR adds, at the same places as the base branch does. */
const OURS = {
  "list.txt": "a\nours\nb\n",
  "src/imports.ts": 'import { a, o } from "./x.ts";\n\nexport const v = [a];\n',
  "styles.css": css(rule("ours", "left")),
  "docs/status.md": "**Status:** Live: WEB-1..5, WEB-7 · **Prefix:** WEB\n",
};
const THEIRS = {
  "list.txt": "a\ntheirs\nb\n",
  "src/imports.ts": 'import { a, t } from "./x.ts";\n\nexport const v = [a];\n',
  "styles.css": css(rule("theirs", "right")),
  "docs/status.md": "**Status:** Live: WEB-1..5, WEB-6 · **Prefix:** WEB\n",
};

const KEPT = { kept_both: true, lost: [], summary: "Both sides are still there." };
const LOST = {
  kept_both: false,
  lost: [{ file: "list.txt", what: "a line is gone" }],
  summary: "A line is gone.",
};

const gates = (p: Pipe) =>
  p.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM transitions WHERE to_stage = 'gate'")!.n;
const conflicts = (p: Pipe) =>
  p.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM transitions WHERE event = 'conflict'")!.n;
const dataOf = (m: Mission) => JSON.parse(m.data) as Record<string, any>;

interface Seen {
  p: Pipe;
  branch: string;
  files: Record<string, string>;
  head: { parents: string[]; author: string; subject: string };
  mission: Mission;
  data: Record<string, any>;
  workers: number;
  reviews: string[];
  conflicts: number;
}

/**
 * The PR is at the gate, the base branch moves (`theirs`), the merge finds a conflict. `extra` is what the
 * worker's later rounds write; `mergeReview` is what the merge review answers.
 */
async function run(o: {
  theirs: Record<string, string>;
  mergeReview?: unknown;
  later?: Record<string, string>[];
}): Promise<Seen> {
  const p = new Pipe(SEED, intents(intent({ a: 5 })), { keep: true });
  happy(p);
  p.queue("worker", reply(build(), { ...CODE, ...OURS }), ...(o.later ?? []).map((e) => reply(build(), e)));
  p.respond.review = (_spec, prompt) => ({
    structured: prompt.includes("<resolved>") ? (o.mergeReview ?? KEPT) : REVIEW,
  });
  await p.start();
  await p.until(() => gates(p) === 1);
  p.pushTo("web", "main", o.theirs, "base moves");
  p.prNo("web", p.mission()!.pr!).mergeStates.push("DIRTY");
  await p.until(() => gates(p) === 2 || p.mission()?.stage === "done");
  const m = p.mission()!;
  const bare = p.bares.web!;
  const files = Object.fromEntries(
    Object.keys(SEED)
      .filter((f) => !f.startsWith("tests/") && f !== "CLAUDE.md")
      .map((f) => [f, p.show("web", m.branch, f)]),
  );
  const [parents, author, subject] = git(bare, "log", "-1", "--format=%P%n%an%n%s", m.branch).split("\n");
  await p.until(() => p.mission()?.stage === "done");
  return {
    p,
    branch: m.branch,
    files,
    head: { parents: parents!.split(" "), author: author!, subject: subject! },
    mission: p.mission()!,
    data: dataOf(m),
    workers: p.claudeCalls.filter((c) => c.kind === "worker").length,
    reviews: p.claudeCalls.filter((c) => c.kind === "review").map((c) => c.prompt),
    conflicts: conflicts(p),
  };
}

const seen: Seen[] = [];
afterAll(() => {
  for (const s of seen) s.p.cleanup();
});
const remember = async (s: Promise<Seen>) => {
  const r = await s;
  seen.push(r);
  return r;
};

let additive: Promise<Seen> | null = null;
const merged = () => {
  additive ??= remember(run({ theirs: THEIRS }));
  return additive;
};

test("pipeline: a mechanical resolution uses no worker round", async () => {
  const s = await merged();
  expect(s.mission.stage, s.p.moves()).toBe("done");
  // The three real cases of 2026-11-05 at once: import list, a key list, CSS blocks and a Status line.
  expect(s.files["list.txt"]).toBe("a\nours\ntheirs\nb\n");
  expect(s.files["src/imports.ts"]).toBe('import { a, o, t } from "./x.ts";\n\nexport const v = [a];\n');
  expect(s.files["docs/status.md"]).toBe("**Status:** Live: WEB-1..7 · **Prefix:** WEB\n");
  const sheet = s.files["styles.css"]!;
  expect(sheet).toBe(css(rule("ours", "left") + rule("theirs", "right")));
  // One worker run in all (the build), and the conflict is no counted round.
  expect(s.workers).toBe(1);
  expect(s.conflicts).toBe(1);
  expect(s.data.conflictRounds).toBeUndefined();
  expect(s.data.repair).toBeUndefined();
});

test("pipeline: a mechanical merge commit is Towercab's own at the gate", async () => {
  const s = await merged();
  // A merge of the base into the PR, by the bot; nobody else's commits are on the PR.
  expect(s.head.parents).toHaveLength(2);
  expect(s.head.author).toBe("towercab[bot]");
  expect(s.head.subject).toContain("both sides only added");
  expect(s.data.foreignHead).toBeFalsy();
  expect(s.p.stages(s.mission.id)).not.toContain("blocked");
});

test("pipeline: a mechanical merge is reviewed on its own diff only", async () => {
  const s = await merged();
  const merge = s.reviews.filter((r) => r.includes("<resolved>"));
  expect(merge).toHaveLength(1);
  // It is told the merge's diff against the PR head before the merge, and how each file was resolved.
  expect(merge[0]).toMatch(/git diff [0-9a-f]{40} HEAD/);
  expect(merge[0]).toContain("list.txt: 1 conflicting hunk, both sides kept");
  // Its own session (new, read-only) and its comment on the PR.
  const call = s.p.claudeCalls.find((c) => c.prompt === merge[0])!;
  expect(call.session.mode).toBe("new");
  const comments = s.p.prNo("web", s.mission.pr!).comments.map((c) => c.body);
  expect(comments.some((b) => b.includes("Merge review") && b.includes("both sides kept"))).toBe(true);
});

test("pipeline: a mechanical merge does not trigger a full review", async () => {
  const s = await merged();
  // The review of the first head (one run) plus the merge review: two runs of the review model in all.
  expect(s.reviews).toHaveLength(2);
  expect(s.data.mech).toBeUndefined();
  expect(s.data.review.approved).toBe(true);
  // The kept review and risk assessment are of the merge head.
  expect(s.data.riskOf.code).toBe(s.data.review.patchId);
});

test("pipeline: a mechanical resolution that fails the full checks goes to the worker", async () => {
  // The base's new test passes on the base alone and fails once both lists are in the merge.
  const s = await remember(
    run({
      theirs: { ...THEIRS, "tests/theirs.sh": '[ "$(wc -l < list.txt)" -le 3 ]\n' },
      later: [{ "list.txt": "a\nours\nb\n" }],
    }),
  );
  expect(s.mission.stage, s.p.moves()).toBe("done");
  // The merge made by code was thrown away before any push; the worker's round is the one that counts.
  expect(s.workers).toBe(2);
  expect(s.data.conflictRounds.n).toBe(1);
  expect(s.data.mechFailed).toBeUndefined();
  expect(s.reviews.filter((r) => r.includes("<resolved>"))).toHaveLength(0);
  expect(git(s.p.bares.web!, "log", "--format=%s", "main").includes("both sides only added")).toBe(false);
  expect(s.p.logs.some((l) => l.includes("the merge made by code is dropped"))).toBe(true);
});

test("pipeline: a merge review that finds a lost side goes to the worker", async () => {
  const s = await remember(
    run({ theirs: THEIRS, mergeReview: LOST, later: [{ "list.txt": "a\nours\ntheirs\nb\n" }] }),
  );
  expect(s.mission.stage, s.p.moves()).toBe("done");
  expect(s.workers).toBe(2);
  expect(s.data.conflictRounds.n).toBe(1);
  // The verdict is on the PR, and a full review runs for the worker's new head.
  const comments = s.p.prNo("web", s.mission.pr!).comments.map((c) => c.body);
  expect(comments.some((b) => b.includes("Merge review") && b.includes("a side was lost"))).toBe(true);
  expect(s.reviews.filter((r) => !r.includes("<resolved>")).length).toBeGreaterThanOrEqual(2);
});
