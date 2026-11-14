// Deferred outcomes (PIP-208, PIP-209): an outcome the owner moved to another intent counts as met, by one
// strict line, and is listed in the review and the PR body. Nothing else defers.

import { expect, test } from "vitest";
import { prEvents } from "../../src/github/events.ts";
import { agentReplyBody } from "../../src/github/owner.ts";
import type { PrComment, PrState } from "../../src/github/prs.ts";
import type { Intent } from "../../src/intents/types.ts";
import type { Mission } from "../../src/mission.ts";
import { insertMission } from "../../src/mission.ts";
import { applyDeferrals, bulletsOf, parseDefer } from "../../src/pipeline/deferrals.ts";
import { codeBody } from "../../src/pipeline/prtext.ts";
import { deferralsOf, reviewComment, reviewDecision, verdictLine } from "../../src/pipeline/review.ts";
import type { ReviewResult } from "../../src/pipeline/schemas.ts";
import { defaultReview } from "../../src/repo/files.ts";
import { BOT } from "../github/fakes.ts";
import { happy, intent, intents, REVIEW, reply, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";
import { testDb } from "../helpers/world.ts";

const LATER = "261105-0630";
const R = REVIEW as ReviewResult;
const HELLO = { bullet: "The page says hello", met: true, owner: false, why: "greeting.txt" };
const GOODBYE = { bullet: "It says goodbye", met: false, owner: false, why: "not there" };
const OUTCOME = `- The page says hello\n- It says goodbye\n- spec IDs: WEB-1\n`;

interface World {
  outcome?: string;
  answers?: string;
  plan?: string | null;
  deferrals?: unknown[];
  ids?: string[];
}

/** The bullets deferred for an intent with this text, under a fake store and mission. */
async function deferredBy(w: World): Promise<string[]> {
  const sections = new Map<string, string>([["Proposed outcome", w.outcome ?? OUTCOME]]);
  if (w.answers) sections.set("Answers", w.answers);
  const it = { id: "261105-0810", dir: "intents/261105-0810-x", sections } as unknown as Intent;
  const cx = {
    store: {
      list: async () => ({ open: (w.ids ?? [LATER]).map((id) => ({ id })), done: [] }),
      readFile: async () => w.plan ?? null,
    },
    checkout: () => "/nonexistent",
  };
  const m = {
    data: JSON.stringify({ deferrals: w.deferrals ?? [], plan: { md: "defer 1 to 261105-0630" } }),
  };
  const { bullets, hits } = await deferralsOf(cx as never, m as Mission, it);
  return hits.map((h) => bullets[h.i]!.text);
}

const pr = (comments: PrComment[]): PrState => ({
  state: "OPEN",
  mergedAt: null,
  mergeCommit: null,
  head: "h1",
  mergeable: "MERGEABLE",
  body: "",
  isDraft: false,
  reviews: [],
  comments,
});
const said = (body: string, id: string, author = "owner"): PrComment => ({
  author,
  at: "2026-11-06T10:00:00Z",
  body,
  id,
});

/** The deferrals that an owner-side read of these comments records, as prEvents puts them in data. */
function recorded(comments: PrComment[]): unknown[] {
  const db = testDb();
  const m = insertMission(db, { intent: "261105-0810", slug: "x", repo: "web", model: "opus", a: 5 }, 0);
  db.run("UPDATE missions SET stage = 'blocked', waiting = 'answer', pr = 7 WHERE id = ?", m.id);
  const row = db.get<typeof m>("SELECT * FROM missions WHERE id = ?", m.id)!;
  return (prEvents(row, { code: pr(comments) }, "owner", BOT)?.data?.deferrals as unknown[]) ?? [];
}

test("pipeline: a deferred outcome does not override an Approve", async () => {
  // towercab#182: the reviewer approves, one outcome reads as not met, and the owner had deferred it.
  const text = intent({ a: 5, body: `- It says goodbye (deferred: ${LATER})\n` });
  const p = new Pipe(TARGET, {
    ...intents(text),
    [`done/${LATER}-later/intent.md`]: intent({ title: "Later", a: null }),
  });
  happy(p);
  p.queue("review", reply({ ...REVIEW, outcomes: [HELLO, GOODBYE] }));
  await p.start();
  await p.until(() => p.mission()?.stage === "done");
  const m = p.mission()!;
  expect(m.stage, p.moves()).toBe("done");
  expect(JSON.parse(m.data).reviewFixes).toBeUndefined();
  expect(p.claudeCalls.filter((c) => c.kind === "worker")).toHaveLength(1);
  const pr = p.prNo("web", m.pr!);
  const review = pr.comments[0]!.body;
  expect(review).toContain("**Verdict:** Approve");
  expect(review).not.toContain("overrode");
  expect(review).toContain(`It says goodbye (moved to intent ${LATER}`);
  expect(JSON.parse(m.data).deferred).toEqual([
    { bullet: "It says goodbye", to: LATER, by: "the intent", unmet: true },
  ]);
  expect(pr.body).toContain("## Deferred");
}, 30_000);

test("pipeline: an outcome marked deferred in the intent counts as met", async () => {
  const outcome = `- The page says hello\n- It says goodbye (deferred: ${LATER})\n`;
  expect(bulletsOf(outcome)[1]).toEqual({ text: "It says goodbye", mark: LATER });
  expect(await deferredBy({ outcome })).toEqual(["It says goodbye"]);
  // Not in the exact form: no mark, no deferral.
  expect(await deferredBy({ outcome: `- It says goodbye, deferred to ${LATER}\n` })).toEqual([]);
});

test("pipeline: a defer line naming an outcome by its quoted text defers it", async () => {
  const line = `defer "it says GOODBYE" to ${LATER}`;
  expect(parseDefer(line)).toEqual({ name: "it says GOODBYE", to: LATER });
  expect(recorded([said(line, "c1")])).toEqual([{ name: "it says GOODBYE", to: LATER }]);
  expect(await deferredBy({ deferrals: [{ name: "it says GOODBYE", to: LATER }] })).toEqual([
    "It says goodbye",
  ]);
  // The answers of the intent file count too.
  const answers = `- 2026-11-06 10:00: defer "It says goodbye" to ${LATER}`;
  expect(await deferredBy({ answers })).toEqual(["It says goodbye"]);
});

test("pipeline: a defer line naming an outcome by its number defers it", async () => {
  expect(parseDefer(`defer 2 to ${LATER}`)).toEqual({ n: 2, to: LATER });
  expect(await deferredBy({ deferrals: [{ n: 2, to: LATER }] })).toEqual(["It says goodbye"]);
  // Counted from 1, over the bullets as written; no such bullet defers nothing.
  expect(await deferredBy({ deferrals: [{ n: 9, to: LATER }] })).toEqual([]);
  expect(parseDefer(`defer 0 to ${LATER}`)).toBeNull();
});

test("pipeline: a comment not in the defer form defers nothing", async () => {
  for (const line of [
    `Defer "It says goodbye" to ${LATER}`,
    `I defer "It says goodbye" to ${LATER}`,
    `defer "It says goodbye" to ${LATER} please`,
    `defer It says goodbye to ${LATER}`,
    `defer "It says goodbye" till ${LATER}`,
    `defer "It says goodbye" to 2120`,
    `- defer 2 to ${LATER}`,
    `the goodbye is for a later slice, ${LATER}`,
  ]) {
    expect(parseDefer(line), line).toBeNull();
    expect(recorded([said(line, "c1")]), line).toEqual([]);
  }
});

test("pipeline: a defer line in the plan defers the outcome", async () => {
  const plan = `## Approach\n\nSmall.\n\ndefer "It says goodbye" to ${LATER}\n\n## Steps\n\n1. Test\n`;
  expect(await deferredBy({ plan })).toEqual(["It says goodbye"]);
  expect(await deferredBy({ plan: `defer 1 to ${LATER}` })).toEqual(["The page says hello"]);
});

test("pipeline: loose wording in a plan defers nothing", async () => {
  const plan = `The goodbye is for a later slice, in intent ${LATER}.\n\nDefer the goodbye to ${LATER}.\n`;
  expect(await deferredBy({ plan })).toEqual([]);
});

test("pipeline: a defer line in an unmerged plan defers nothing", async () => {
  // The merged plan is the one in the intents repo; the text of a plan PR still open is in `data.plan.md`
  // (the fake mission carries a defer line there) and is never read.
  expect(await deferredBy({ plan: null })).toEqual([]);
});

test("pipeline: a deferral by an agent or a non-owner is ignored", async () => {
  const line = `defer 2 to ${LATER}`;
  expect(recorded([said(line, "c1", "stranger")])).toEqual([]);
  expect(recorded([said(agentReplyBody("claude-code", "Majid", line), "c2")])).toEqual([]);
  expect(recorded([said(line, "c3")])).toEqual([{ n: 2, to: LATER }]);
});

test("pipeline: a deferral to an unknown intent is ignored", async () => {
  expect(await deferredBy({ deferrals: [{ n: 2, to: "261105-9999" }] })).toEqual([]);
  // The intent itself is no follow-up.
  expect(await deferredBy({ deferrals: [{ n: 2, to: "261105-0810" }], ids: ["261105-0810"] })).toEqual([]);
  expect(await deferredBy({ outcome: `- A (deferred: 261105-9999)\n` })).toEqual([]);
});

test("pipeline: a deferred outcome starts no fix round", () => {
  const unmet = { ...R, outcomes: [HELLO, GOODBYE] };
  expect(reviewDecision(unmet, 0).round).toBe(1);
  const bullets = bulletsOf(`- The page says hello\n- It says goodbye\n`);
  const { result, deferred } = applyDeferrals(unmet, bullets, [
    { i: 1, to: LATER, by: "the owner's comment" },
  ]);
  const d = reviewDecision(result, 0, deferred);
  expect(d).toMatchObject({ approved: true, round: null, fixable: [], overridden: false });
  expect(deferred).toEqual([
    { bullet: "It says goodbye", to: LATER, by: "the owner's comment", unmet: true },
  ]);
  // An owner step the owner deferred is no owner step any more; other outcomes are not touched.
  const step = { bullet: "Add the secret", met: false, owner: true, why: "only the owner" };
  const both = applyDeferrals({ ...R, outcomes: [HELLO, step] }, bulletsOf("- a\n- Add the secret\n"), [
    { i: 1, to: LATER, by: "the plan" },
  ]);
  expect(reviewDecision(both.result, 0).ownerSteps).toEqual([]);
  expect(verdictLine(d)).toContain("Approve (one outcome is counted as met because you deferred it)");
});

test("pipeline: the review comment lists deferred outcomes", () => {
  const deferred = [{ bullet: "It says goodbye", to: LATER, by: "the owner's answer", unmet: true }];
  const bullets = bulletsOf("- The page says hello\n- It says goodbye\n");
  const { result } = applyDeferrals({ ...R, outcomes: [HELLO, GOODBYE] }, bullets, [
    { i: 1, to: LATER, by: "the owner's answer" },
  ]);
  const body = reviewComment(result, defaultReview(), deferred);
  expect(body).toContain(
    `**Deferred**\n\n- It says goodbye (moved to intent ${LATER}, deferred by the owner's answer)`,
  );
  expect(body).toContain("- Deferred: It says goodbye");
  expect(reviewComment(R, defaultReview())).not.toContain("**Deferred**");
});

test("pipeline: the PR body lists deferred outcomes", () => {
  const base = {
    worker: null,
    intentTitle: "Show a greeting",
    intentProblem: null,
    checks: null,
    unplanned: [],
    specIds: [],
    links: { intentUrl: null, specPrUrl: null, planPrUrl: null },
    reviewDetails: null,
    footer: { intentUrl: null, costUsd: 0, secs: 0 },
    // biome-ignore lint/suspicious/noExplicitAny: only the fields this test sets matter
  } as any;
  const body = codeBody({ ...base, deferred: [{ bullet: "It says goodbye", to: LATER, by: "the intent" }] });
  expect(body).toContain(
    `## Deferred\n\n- It says goodbye (moved to intent ${LATER}, deferred by the intent)`,
  );
  expect(codeBody(base)).not.toContain("## Deferred");
});
