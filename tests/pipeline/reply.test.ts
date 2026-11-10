// The reply to the owner's comments (PIP-203, PIP-204): what a revision is asked for, the generic reply
// Towercab writes when the worker wrote none, and how a post that fails is tried again. The posting goes
// through a fake `Forge`; the revision flow itself is in `reply-flow.test.ts`.

import { expect, test } from "vitest";
import type { Result } from "../../src/forge.ts";
import type { ReplyTarget } from "../../src/github/events.ts";
import type { Ctx } from "../../src/handlers.ts";
import type { Mission } from "../../src/mission.ts";
import type { PipeData } from "../../src/pipeline/common.ts";
import {
  deliverReply,
  type Facts,
  GENERIC_FILES,
  genericReply,
  type PendingReply,
  REPLY_TRIES,
  replyPatch,
  replySection,
} from "../../src/pipeline/reply.ts";
import { parseResult, SCHEMAS, withReply } from "../../src/pipeline/schemas.ts";
import { FakeForge } from "../helpers/fake-forge.ts";

class ThreadForge extends FakeForge {
  readonly threads: { commentId: string; marker: string; text: string }[] = [];
  failThreads = false;
  async replyInThread(
    _repo: string,
    _n: number,
    commentId: string,
    marker: string,
    text: string,
  ): Promise<Result> {
    if (this.failThreads) return { ok: false, reason: "Not Found" };
    this.threads.push({ commentId, marker, text });
    return { ok: true, reason: "" };
  }
}

const target = (id: string, excerpt: string, thread = ""): ReplyTarget => ({
  kind: "spec",
  id,
  thread,
  url: "",
  excerpt,
});

const FACTS: Facts = { sha: "abc1234", files: ["specs/web.md"] };

/** A spec PR on the fake host and a mission stub with `reply` waiting to be posted. */
async function world(pending: PendingReply | undefined) {
  const forge = new ThreadForge();
  const n = (await forge.openPr("o/web", { base: "main", head: "b", title: "t", body: "x" }))!;
  const logs: string[] = [];
  const cx = {
    github: forge,
    repo: () => ({ github: "o/web" }),
    store: { github: () => "o/intents" },
    log: (l: string) => logs.push(l),
    record: (m: Mission, step: string, _set: unknown, d: Record<string, unknown> = {}) => ({
      ...m,
      step,
      data: JSON.stringify({ ...JSON.parse(m.data), ...d }),
    }),
  } as unknown as Ctx;
  const m = {
    intent: "261102-0019",
    stage: "design",
    step: "spec_ci",
    pr: null,
    plan_pr: null,
    spec_pr: n,
    head: "abc1234def",
    data: JSON.stringify({ reply: pending }),
  } as unknown as Mission;
  return { forge, n, cx, logs, m };
}

const pending = (o: Partial<PendingReply> = {}): PendingReply => ({
  text: "Done: the empty page case is in.",
  targets: [target("c1", "Please add an empty page case.")],
  before: "aaa",
  round: 1,
  tries: 0,
  ...o,
});

const stored = (m: Mission) => JSON.parse(m.data) as PipeData;

const DESIGN = {
  title: "Show a greeting",
  subject: "show a greeting",
  brief: "b",
  type: "feat",
  scope: "",
  breaking: false,
  spec_ids: ["WEB-1"],
  concerns: [],
  open_questions: [],
  pr: "The page will greet visitors.",
};

test("pipeline: a feedback revision asks for a reply", () => {
  const targets = [target("c1", "Add an empty page case."), target("c2", "Name the greeting text.")];
  // The prompt lists the comments and asks for `reply`; only then does the run's schema carry it.
  const section = replySection(targets);
  expect(section).toContain("`reply`");
  expect(section).toContain("[c1] Add an empty page case.");
  expect(replySection(undefined)).toBe("");
  expect(replySection([])).toBe("");
  expect((SCHEMAS.design as { required: string[] }).required).not.toContain("reply");
  const asked = withReply(SCHEMAS.design) as { required: string[]; properties: Record<string, unknown> };
  expect(asked.required).toContain("reply");
  expect(asked.properties.reply).toEqual({ type: "string" });
  // The reply is kept with the comments it answers, and the comments are done with.
  const patch = replyPatch({ replyTo: targets } as unknown as PipeData, "  Done.  ", "abc") as unknown as {
    reply: PendingReply;
    replyTo?: unknown;
    replyRounds: number;
  };
  expect(patch.reply).toEqual({ text: "Done.", targets, before: "abc", round: 1, tries: 0 });
  expect(patch.replyTo).toBeUndefined();
  expect(patch.replyRounds).toBe(1);
  const again = { replyTo: targets, replyRounds: 1 } as unknown as PipeData;
  const next = replyPatch(again, "More.", null) as unknown as { reply: PendingReply };
  expect(next.reply.round).toBe(2);
});

test("pipeline: a revision Towercab started needs no reply", async () => {
  // No comments, no reply: nothing is kept and nothing is posted.
  expect(replyPatch({} as unknown as PipeData, "Done.", null)).toEqual({});
  const w = await world(undefined);
  const out = await deliverReply(w.cx, w.m, async () => FACTS);
  expect(out.retry).toBe(false);
  expect(w.forge.calls).toEqual([`open o/web#${w.n} b`]);
});

test("pipeline: a missing reply gets a generic one with files and commit", async () => {
  const w = await world(pending({ text: "" }));
  const out = await deliverReply(w.cx, w.m, async () => FACTS);
  expect(out.retry).toBe(false);
  const body = w.forge.prs[0]!.comments[0]!;
  expect(body.split("\n")[0]).toBe("<!-- towercab:reply:1 -->");
  expect(body).toContain("Revised in `abc1234`.");
  expect(body).toContain("- `specs/web.md`");
  expect(body).toContain("> Please add an empty page case.");
  expect(stored(out.m).reply).toBeUndefined();
});

test("pipeline: the generic reply is marked generated", () => {
  const text = genericReply(FACTS);
  expect(text).toContain("Generated by Towercab: the worker wrote no reply.");
  const many = genericReply({
    sha: "abc1234",
    files: Array.from({ length: GENERIC_FILES + 5 }, (_, i) => `f${i}.ts`),
  });
  expect(many.split("\n").filter((l) => l.startsWith("- `"))).toHaveLength(GENERIC_FILES);
  expect(many).toContain("- and 5 more");
  expect(many).toContain("Generated by Towercab");
});

test("pipeline: a missing reply never blocks or repeats a revision", () => {
  // The run is asked for a reply, but a result without one (or with one that is not text) still parses.
  expect(parseResult("design", DESIGN).ok).toBe(true);
  const written = parseResult("design", { ...DESIGN, reply: "Done." });
  expect(written.ok && written.value.reply).toBe("Done.");
  const odd = parseResult("design", { ...DESIGN, reply: 5 });
  expect(odd.ok).toBe(true);
  expect(odd.ok && "reply" in odd.value).toBe(false);
  // An unknown key other than `reply` is still refused.
  expect(parseResult("design", { ...DESIGN, other: 1 }).ok).toBe(false);
});

test("pipeline: a revision that changes nothing still replies", async () => {
  const w = await world(pending({ text: "", before: "abc1234def" }));
  const out = await deliverReply(w.cx, w.m, async () => ({ sha: "abc1234", files: [] }));
  expect(out.retry).toBe(false);
  const body = w.forge.prs[0]!.comments[0]!;
  expect(body).toContain("No files changed.");
  expect(body).toContain("Generated by Towercab");
  // The worker's own `Nothing to change: <why>` is posted as written.
  const w2 = await world(pending({ text: "Nothing to change: the spec already says so." }));
  await deliverReply(w2.cx, w2.m, async () => FACTS);
  expect(w2.forge.prs[0]!.comments[0]).toContain("Nothing to change: the spec already says so.");
});

test("pipeline: a failed reply post is retried", async () => {
  const w = await world(pending());
  w.forge.failNext("upsertPrComment", REPLY_TRIES - 1);
  // Failed once: the reply is kept, with a try counted, and the step comes back.
  const first = await deliverReply(w.cx, w.m, async () => FACTS);
  expect(first.retry).toBe(true);
  expect(stored(first.m).reply?.tries).toBe(1);
  expect(w.forge.prs[0]!.comments).toEqual([]);
  // Failed twice: the same.
  const second = await deliverReply(w.cx, first.m, async () => FACTS);
  expect(second.retry).toBe(true);
  // The next time it goes up, once, and the gist is kept for the owner's message.
  const third = await deliverReply(w.cx, second.m, async () => FACTS);
  expect(third.retry).toBe(false);
  expect(w.forge.prs[0]!.comments).toHaveLength(1);
  const after = stored(third.m);
  expect(after.reply).toBeUndefined();
  expect(after.replyNote?.gist).toBe("Done: the empty page case is in.");

  // A host that keeps refusing is given up on after REPLY_TRIES posts; the mission is never held for it.
  const down = await world(pending());
  down.forge.failNext("upsertPrComment", REPLY_TRIES);
  let cur = down.m;
  for (let i = 0; i < REPLY_TRIES - 1; i++) cur = (await deliverReply(down.cx, cur, async () => FACTS)).m;
  const last = await deliverReply(down.cx, cur, async () => FACTS);
  expect(last.retry).toBe(false);
  expect(stored(last.m).reply).toBeUndefined();
  expect(stored(last.m).replyNote).toBeUndefined();
});

test("pipeline: a failed pointer does not hold back the reply", async () => {
  const w = await world(pending({ targets: [target("c1", "Line comment.", "77")] }));
  w.forge.failThreads = true;
  const out = await deliverReply(w.cx, w.m, async () => FACTS);
  expect(out.retry).toBe(false);
  expect(w.forge.prs[0]!.comments).toHaveLength(1);
  expect(w.logs.join("\n")).toContain("couldn't answer in a review thread");
  expect(stored(out.m).reply).toBeUndefined();
  expect(stored(out.m).replyNote).toBeDefined();
  // With the thread open, the pointer goes up after the general comment.
  const ok = await world(pending({ targets: [target("c1", "Line comment.", "77")] }));
  await deliverReply(ok.cx, ok.m, async () => FACTS);
  expect(ok.forge.threads.map((t) => t.commentId)).toEqual(["77"]);
});
