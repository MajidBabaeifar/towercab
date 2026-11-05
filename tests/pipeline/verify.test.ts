// Red checks and questions (PIP-23, PIP-41): verify sends a red back to the worker twice, then waits
// for the owner; the owner's reply continues the build, and the worker's question reaches the
// intent's current PR as a Question comment.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { build, happy, ID, intent, intents, TARGET } from "../helpers/flows.ts";
import { type ClaudeReply, Pipe } from "../helpers/pipe.ts";

let p: Pipe;

beforeAll(async () => {
  p = new Pipe(TARGET, intents(intent({ a: 5 })), { keep: true });
  happy(p);
  let round = 0;
  // The test wants "bye"; the worker keeps writing "hello".
  p.respond.worker = (): ClaudeReply => {
    round++;
    return {
      structured: build(),
      edits:
        round === 1
          ? {
              "greeting.txt": "hello\n",
              "tests/greeting.sh": "grep -q bye greeting.txt || { echo 'no bye in greeting.txt'; exit 1; }\n",
            }
          : { "greeting.txt": `hello ${round}\n` },
    };
  };
  await p.start();
}, 30_000);

afterAll(() => p.cleanup());

const workers = () => p.claudeCalls.filter((c) => c.kind === "worker");

test("pipeline: verify red repairs then waits", async () => {
  const m = await p.untilStage("blocked");
  expect([m.waiting, m.why], p.moves()).toEqual([
    "checks red",
    "Still failing after 2 fix attempts: The checks failed.",
  ]);
  expect(workers()).toHaveLength(3);
  const reds = p.db.all<{ from_stage: string; to_stage: string }>(
    "SELECT from_stage, to_stage FROM transitions WHERE event = 'red' ORDER BY id",
  );
  expect(reds).toEqual([
    { from_stage: "verify", to_stage: "build" },
    { from_stage: "verify", to_stage: "build" },
  ]);
  for (const w of workers().slice(1)) {
    expect(w.prompt).toMatch(/^The checks failed\./);
    expect(w.prompt).toContain("no bye in greeting.txt");
    expect(w.prompt).toContain("$ sh -c 'for t in tests/*.sh");
  }
  // Nothing was published: no code PR.
  expect(m.pr).toBeNull();
  expect(p.stages(m.id)).not.toContain("publish");
}, 30_000);

test("runs: repair prompt reads the stage log", () => {
  // The failed round's output is in verify/, and its tail is what the next worker round is told.
  const log = readFileSync(join(p.home.runs(ID, "verify"), "verify-1.log"), "utf8");
  expect(log).toContain("no bye in greeting.txt");
  expect(workers()[1]!.prompt).toContain("no bye in greeting.txt");
  // Each round keeps its own log.
  expect(readFileSync(join(p.home.runs(ID, "verify"), "verify-2.log"), "utf8")).toContain("no bye");
  expect(workers()[0]!.prompt).not.toContain("no bye in greeting.txt");
});

test("pipeline: question comment has context, options, recommendation", async () => {
  const m = p.mission()!;
  // The owner replies on the intent's current PR (the merged plan PR): the build continues.
  const plan = p.prNo("intents", m.plan_pr!);
  p.ownerComment(plan, "The test is right: say bye.");
  p.script(() => ({
    structured: build({
      status: "blocked",
      pr: null,
      question: {
        context: "The test wants bye, but the intent says the page says hello.",
        question: "Should the page say hello or bye?",
        options: [
          // biome-ignore lint/suspicious/noThenProperty: the spec's key; never awaited.
          { option: "hello", then: "I change the test", do: "continue" },
          // biome-ignore lint/suspicious/noThenProperty: the spec's key; never awaited.
          { option: "bye", then: "I change the page", do: "continue" },
        ],
        recommendation: "hello, as the intent says.",
      },
    }),
  }));
  p.clock.advance(61);
  await p.until(() => p.mission()?.waiting === "answer the question", 20);
  const after = p.mission()!;
  expect(after.waiting, p.moves()).toBe("answer the question");
  const w = workers()[3]!;
  expect(w.prompt).toContain("The owner answered");
  expect(w.prompt).toContain("The test is right: say bye.");
  expect(after.waiting).toBe("answer the question");
  expect(after.why).toBe("Should the page say hello or bye?");
  const q = plan.comments.filter((c) => c.author === "towercab[bot]");
  expect(q).toHaveLength(1);
  const body = q[0]!.body;
  expect(body).toMatch(/^<!-- towercab:question:\d+ -->\n\*\*Question\*\* · round \d+\n\n/);
  expect(body).toContain("The test wants bye, but the intent says the page says hello.");
  expect(body).toContain("**Should the page say hello or bye?**");
  expect(body).toContain("- **hello**: I change the test");
  expect(body).toContain("- **bye**: I change the page");
  expect(body).toContain("**Recommendation:** hello, as the intent says.");
  // The message names the ask and links the PR.
  const msg = p.db.get<{ text: string }>(
    "SELECT text FROM outbox WHERE key LIKE ?",
    `${after.id}:answer the question:%`,
  );
  expect(msg?.text).toMatch(
    /^Answer a question so the work can go on: pick an option or write your own\.\nShow a greeting \(web\)\nShould the page say hello or bye\?\nhttps:\/\/github\.com\/owner\/intents\/pull\/\d+$/,
  );
  void ID;
}, 30_000);
