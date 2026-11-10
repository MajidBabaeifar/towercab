// A spec revision the owner's comments started (PIP-203..207): one reply on the PR that answers each
// comment, posted after the revision is pushed, with the PR description rewritten as before. The tests run
// in order on one story: two comments in one revision, then a third that gets the next reply.

import { afterAll, beforeAll, expect, test } from "vitest";
import { DESIGN, happy, intent, intents, reply, SPEC, TARGET } from "../helpers/flows.ts";
import { type FakePr, Pipe } from "../helpers/pipe.ts";

const MARKER = "<!-- towercab:reply:";
const REVISED_PR = "The page will greet visitors, an empty page included.";

let p: Pipe;
let pr: FakePr;
const flow = { before: "", atReply: [] as string[], bodyBefore: "" };

const designs = () => p.claudeCalls.filter((c) => c.kind === "design");
const replies = () => pr.comments.filter((c) => c.body.startsWith(MARKER));

beforeAll(async () => {
  p = new Pipe(TARGET, intents(intent({ a: 2 })), { keep: true });
  happy(p);
  await p.start();
  const m = await p.untilStage("approval:spec");
  pr = p.prNo("web", m.spec_pr!);
  flow.before = p.headSha("owner/web", pr.head);
  flow.bodyBefore = pr.body;
  // What the branch holds at the moment a reply goes up: the revision must be pushed by then.
  const push = pr.comments.push.bind(pr.comments);
  pr.comments.push = (...xs) => {
    for (const x of xs) if (x.body.startsWith(MARKER)) flow.atReply.push(p.headSha("owner/web", pr.head));
    return push(...xs);
  };
  p.ownerComment(pr, "Please add an empty page case.");
  p.ownerComment(pr, "And name the greeting text.");
  p.script(
    reply(
      {
        ...DESIGN,
        pr: REVISED_PR,
        reply: "First comment: the empty page case is in.\n\nSecond comment: the text is already named.",
      },
      { "specs/web.md": `${SPEC["specs/web.md"]}\nAn empty page says hello too.\n` },
    ),
  );
  p.clock.advance(61);
  await p.untilStage("approval:spec");
}, 60_000);

afterAll(() => p.cleanup());

test("pipeline: the feedback prompt lists each comment with its id", () => {
  const prompt = designs()[1]!.prompt;
  expect(prompt).toMatch(/- \[[^\]]+\] Please add an empty page case\./);
  expect(prompt).toMatch(/- \[[^\]]+\] And name the greeting text\./);
  expect(prompt).toContain("`reply`");
});

test("pipeline: several comments get one reply that answers each", () => {
  expect(replies()).toHaveLength(1);
  const body = replies()[0]!.body;
  expect(body.split("\n")[0]).toBe("<!-- towercab:reply:1 -->");
  // Each comment is quoted, and the worker's answer covers both.
  expect(body).toContain("> Please add an empty page case.");
  expect(body).toContain("> And name the greeting text.");
  expect(body).toContain("First comment: the empty page case is in.");
  expect(body).toContain("Second comment: the text is already named.");
});

test("pipeline: the reply is posted after the revision is pushed", () => {
  expect(flow.atReply).toHaveLength(1);
  expect(flow.atReply[0]).not.toBe(flow.before);
  expect(flow.atReply[0]).toBe(p.headSha("owner/web", pr.head));
  expect(p.show("web", pr.head, "specs/web.md")).toContain("An empty page says hello too.");
});

test("pipeline: a revision still rewrites the PR description", () => {
  expect(flow.bodyBefore).not.toContain(REVISED_PR);
  expect(pr.body).toContain(REVISED_PR);
});

test("pipeline: a comment that arrives during a revision gets the next reply", async () => {
  // A comment that came after the first revision started is taken by the next one, with its own reply.
  p.ownerComment(pr, "One more thing: say hello in French too.");
  p.script(
    reply(
      { ...DESIGN, pr: REVISED_PR, reply: "French: added." },
      { "specs/web.md": `${SPEC["specs/web.md"]}\nAn empty page says hello too.\nBonjour.\n` },
    ),
  );
  p.clock.advance(61);
  await p.untilStage("approval:spec");
  expect(replies()).toHaveLength(2);
  const second = replies()[1]!.body;
  expect(second.split("\n")[0]).toBe("<!-- towercab:reply:2 -->");
  expect(second).toContain("> One more thing: say hello in French too.");
  expect(second).toContain("French: added.");
  // The first reply is not answered again or changed.
  expect(replies()[0]!.body).toContain("First comment: the empty page case is in.");
  expect(replies()[0]!.body).not.toContain("French");
}, 60_000);
