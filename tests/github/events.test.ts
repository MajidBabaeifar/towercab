import { describe, expect, test } from "vitest";
import {
  approveRequested,
  currentPr,
  intentEvents,
  prEvents,
  RELEASE_PARKED,
  releaseRequested,
} from "../../src/github/events.ts";
import type { PrComment, PrReview, PrState } from "../../src/github/prs.ts";
import type { Intent } from "../../src/intents/types.ts";
import { type ApplyCtx, apply, type Stage } from "../../src/machine.ts";
import { dataOf, getMission, insertMission, type Mission } from "../../src/mission.ts";
import { testDb } from "../helpers/world.ts";
import { BOT } from "./fakes.ts";

const ME = "owner";

function world(stage: Stage, cols: Partial<Mission> = {}) {
  const db = testDb();
  const m0 = insertMission(db, { intent: "261001-0900", slug: "x", repo: "web", model: "opus", a: 3 }, 0);
  const all: Record<string, string | number | null> = { stage, step: "", ...cols } as Record<
    string,
    string | number | null
  >;
  if (stage === "blocked" && !("waiting" in cols)) all.waiting = "CI red";
  if (stage.startsWith("approval:") && !("waiting" in cols)) {
    const asks: Record<string, string> = { "approval:spec": "approve spec", "approval:plan": "approve plan" };
    all.waiting = asks[stage] ?? "review and merge PR";
  }
  const keys = Object.keys(all);
  db.run(
    `UPDATE missions SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`,
    ...keys.map((k) => all[k]!),
    m0.id,
  );
  const m = getMission(db, m0.id)!;
  const cx: ApplyCtx = { db, now: 100, subject: () => ({ title: "X", repo: "web", link: null }) };
  return { db, m, cx };
}

const pr = (o: Partial<PrState> = {}): PrState => ({
  state: "OPEN",
  mergedAt: null,
  mergeCommit: null,
  head: "h1",
  mergeable: "MERGEABLE",
  body: "",
  isDraft: false,
  reviews: [],
  comments: [],
  ...o,
});
const said = (author: string, at: string, body: string, id = `c${at}`): PrComment => ({
  author,
  at,
  body,
  id,
});
const review = (
  author: string,
  at: string,
  state: string,
  body = "",
  commit: string | null = "h1",
): PrReview => ({
  author,
  at,
  state,
  body,
  commit,
});
const merged = (sha = "m1") => pr({ state: "MERGED", mergedAt: "2026-10-15T12:00:00Z", mergeCommit: sha });

function intent(o: Partial<Intent> = {}): Intent {
  return {
    id: "261001-0900",
    slug: "x",
    dir: "intents/261001-0900-x",
    done: false,
    title: "X",
    repo: "web",
    u: null,
    i: null,
    a: null,
    after: [],
    model: null,
    review: null,
    source: null,
    started: null,
    unlock: [],
    network: [],
    stage: "code",
    waiting: null,
    specPr: null,
    planPr: null,
    pr: null,
    retry: null,
    cost: null,
    agentTime: null,
    attempts: null,
    finished: null,
    lowerWhy: null,
    sections: new Map(),
    text: "",
    ...o,
  };
}

describe("events", () => {
  test("events: PR events by priority", () => {
    const { m } = world("ci", {
      spec_pr: 3,
      plan_pr: 4,
      pr: 7,
      head: "h1",
      feedback_seen: "2026-10-15T10:00:00Z",
    });
    expect(currentPr(m)).toEqual({ kind: "code", number: 7 });
    // Everything at once: one event, by priority.
    const code = pr({
      head: "h2",
      mergeable: "CONFLICTING",
      comments: [said(ME, "2026-10-15T11:00:00Z", "rename it"), said(ME, "2026-10-15T11:30:00Z", "/retry")],
    });
    expect(prEvents(m, { code: { ...code, state: "MERGED", mergeCommit: "m1" } }, ME, BOT)?.event).toBe(
      "code_merged",
    );
    expect(prEvents(m, { code: { ...code, state: "CLOSED" } }, ME, BOT)?.event).toBe("closed");
    expect(prEvents(m, { code }, ME, BOT)).toEqual({
      event: "feedback",
      text: "rename it",
      set: { feedback_seen: "2026-10-15T11:00:00Z" },
      data: { answer: "rename it" },
    });
    code.comments.shift();
    expect(prEvents(m, { code }, ME, BOT)).toEqual({
      event: "retry_fresh",
      set: { feedback_seen: "2026-10-15T11:30:00Z" },
    });
    code.comments.shift();
    expect(prEvents(m, { code }, ME, BOT)).toEqual({ event: "conflict" });
    code.mergeable = "UNKNOWN";
    expect(prEvents(m, { code }, ME, BOT)).toEqual({ event: "head_moved" });
    code.head = "h1";
    expect(prEvents(m, { code }, ME, BOT)).toBeNull();

    // A merged PR counts only when it is the current one: the spec PR's merge is old news here.
    expect(prEvents(m, { spec: merged(), code: pr() }, ME, BOT)).toBeNull();
    // A closed one counts on any of the intent's PRs.
    expect(prEvents(m, { spec: pr({ state: "CLOSED" }), code: pr() }, ME, BOT)?.event).toBe("closed");
    // No head recorded yet: no head_moved; finished missions: nothing.
    const fresh = world("design", { spec_pr: 3 }).m;
    expect(prEvents(fresh, { spec: pr({ head: "h9" }) }, ME, BOT)).toBeNull();
    expect(prEvents(world("done", { pr: 7 }).m, { code: pr({ state: "CLOSED" }) }, ME, BOT)).toBeNull();
    // Feedback while blocked is the answer; comments on two PRs say which.
    const blocked = world("blocked", { spec_pr: 3, pr: 7, head: "h1" }).m;
    const o = prEvents(
      blocked,
      {
        spec: pr({ comments: [said(ME, "2026-10-15T11:00:00Z", "a")] }),
        code: pr({ comments: [said(ME, "2026-10-15T11:01:00Z", "b")] }),
      },
      ME,
      BOT,
    );
    expect(o).toMatchObject({ event: "answered", text: "(spec PR) a\n\n(code PR) b" });
  });

  test("events: intent events", () => {
    const { m } = world("blocked", { waiting: "CI red" });
    expect(intentEvents(m, intent({ waiting: "CI red" }))).toBeNull();
    expect(intentEvents(m, intent({ waiting: null }))).toEqual({ event: "answered" });
    expect(intentEvents(m, intent({ waiting: "CI red", retry: "fresh" }))).toEqual({ event: "retry_fresh" });
    expect(intentEvents(m, null)).toEqual({ event: "intent_removed" });
    expect(intentEvents(m, intent({ done: true }))).toEqual({ event: "intent_removed" });
    // Not while the entry write is due: the intent doesn't show the wait yet.
    expect(intentEvents({ ...m, step: "enter" }, intent())).toBeNull();
    // `waiting` gone means nothing outside blocked; finished missions get nothing.
    expect(intentEvents(world("build").m, intent())).toBeNull();
    expect(intentEvents(world("approval:spec").m, intent())).toBeNull();
    expect(intentEvents(world("stopped").m, null)).toBeNull();

    // Through the machine: removed stops, retry: fresh starts attempt 2, answered continues.
    const w = world("blocked", { waiting: "CI red", from_stage: "ci" });
    expect(apply(w.cx, w.m, intentEvents(w.m, intent())!).stage).toBe("build");
    const r = world("build");
    const next = apply(r.cx, r.m, intentEvents(r.m, intent({ retry: "fresh" }))!);
    expect([next.stage, next.attempt]).toEqual(["pick", 2]);
    expect(getMission(r.db, r.m.id)!.why).toBe("replaced by attempt 2");
    const gone = world("approval:merge", { pr: 7 });
    expect(apply(gone.cx, gone.m, intentEvents(gone.m, null)!).stage).toBe("stopped");
  });

  test("events: owner merge during CI ends done", () => {
    const { db, m, cx } = world("ci", { pr: 7, head: "h1", feedback_seen: "2026-10-15T10:00:00Z" });
    const o = prEvents(m, { code: merged("abc123") }, ME, BOT)!;
    expect(o).toEqual({ event: "code_merged", set: { merge_sha: "abc123", merged_by: "owner" } });
    const after = apply(cx, m, o);
    expect([after.stage, after.merged_by, after.merge_sha]).toEqual(["done", "owner", "abc123"]);
    expect(db.all("SELECT * FROM transitions")).toMatchObject([
      { from_stage: "ci", event: "code_merged", to_stage: "done" },
    ]);
    expect(db.all("SELECT * FROM outbox")).toEqual([]);
    // Towercab's own merge (recorded before it) keeps its name; done ignores the next read.
    const own = world("merge", { pr: 7, merged_by: "towercab" });
    expect(prEvents(own.m, { code: merged() }, ME, BOT)?.set?.merged_by).toBe("towercab");
    expect(prEvents(after, { code: merged() }, ME, BOT)).toBeNull();
  });

  test("events: merge, close, review and comment", () => {
    // The owner merges each PR: the mission moves on.
    const spec = world("approval:spec", { spec_pr: 3 });
    expect(apply(spec.cx, spec.m, prEvents(spec.m, { spec: merged() }, ME, BOT)!).stage).toBe("plan");
    const plan = world("approval:plan", { spec_pr: 3, plan_pr: 4 });
    expect(apply(plan.cx, plan.m, prEvents(plan.m, { plan: merged() }, ME, BOT)!).stage).toBe("build");
    const code = world("approval:merge", { spec_pr: 3, plan_pr: 4, pr: 7, head: "h1" });
    expect(apply(code.cx, code.m, prEvents(code.m, { code: merged() }, ME, BOT)!).stage).toBe("done");

    // Closed without merge: stopped and dropped, no message.
    const closed = world("approval:merge", { pr: 7, head: "h1" });
    const stopped = apply(
      closed.cx,
      closed.m,
      prEvents(closed.m, { code: pr({ state: "CLOSED" }) }, ME, BOT)!,
    );
    expect([stopped.stage, dataOf(stopped).dropped]).toEqual(["stopped", true]);

    // Request changes (with or without words): feedback, back to build with the text.
    const rc = world("approval:merge", { pr: 7, head: "h1", feedback_seen: "2026-10-15T10:00:00Z" });
    const o = prEvents(
      rc.m,
      {
        code: pr({
          reviews: [review(ME, "2026-10-15T11:00:00Z", "CHANGES_REQUESTED")],
          comments: [{ ...said(ME, "2026-10-15T11:01:00Z", "off by one"), path: "src/a.ts", line: 4 }],
        }),
      },
      ME,
      BOT,
    )!;
    expect(o.text).toBe("Changes requested.\n\nsrc/a.ts:4: off by one");
    expect(o.set).toEqual({ feedback_seen: "2026-10-15T11:01:00Z" });
    const back = apply(rc.cx, rc.m, o);
    expect([back.stage, back.feedback_seen, dataOf(back).answer]).toEqual([
      "build",
      "2026-10-15T11:01:00Z",
      o.text,
    ]);
    // Taken: the next read of the same PR gives nothing new.
    expect(
      prEvents(
        { ...back, stage: "approval:merge" },
        { code: pr({ reviews: [review(ME, "2026-10-15T11:00:00Z", "CHANGES_REQUESTED")] }) },
        ME,
        BOT,
      ),
    ).toBeNull();

    // A comment on the spec PR sends it back to design.
    const c = world("approval:spec", { spec_pr: 3 });
    const fb = prEvents(
      c.m,
      { spec: pr({ comments: [said(ME, "2026-10-15T11:00:00Z", "split it")] }) },
      ME,
      BOT,
    )!;
    expect(apply(c.cx, c.m, fb).stage).toBe("design");
    // A review comment-only (no body) says nothing by itself; its line comments do.
    const quiet = world("approval:merge", { pr: 7, head: "h1" });
    expect(
      prEvents(
        quiet.m,
        { code: pr({ reviews: [review(ME, "2026-10-15T11:00:00Z", "COMMENTED")] }) },
        ME,
        BOT,
      ),
    ).toBeNull();
  });

  test("events: approve review merges", () => {
    const { m } = world("approval:merge", {
      spec_pr: 3,
      plan_pr: 4,
      pr: 7,
      head: "h1",
      feedback_seen: "2026-10-15T10:00:00Z",
    });
    const approved = pr({ reviews: [review(ME, "2026-10-15T11:00:00Z", "APPROVED", "LGTM")] });
    expect(approveRequested(m, { code: approved }, ME)).toBe(7);
    // An approval is not feedback, even with words.
    expect(prEvents(m, { code: approved }, ME, BOT)).toBeNull();
    // Not on the current head, older than feedback_seen, someone else's, or not waiting: no merge.
    expect(
      approveRequested(
        m,
        { code: pr({ reviews: [review(ME, "2026-10-15T11:00:00Z", "APPROVED", "", "h0")] }) },
        ME,
      ),
    ).toBeNull();
    expect(
      approveRequested(m, { code: pr({ reviews: [review(ME, "2026-10-15T09:00:00Z", "APPROVED")] }) }, ME),
    ).toBeNull();
    expect(
      approveRequested(m, { code: pr({ reviews: [review("x", "2026-10-15T11:00:00Z", "APPROVED")] }) }, ME),
    ).toBeNull();
    expect(approveRequested(m, { code: { ...approved, state: "MERGED" } }, ME)).toBeNull();
    expect(approveRequested({ ...m, stage: "ci" }, { code: approved }, ME)).toBeNull();
    // The spec and plan waits approve their own PR.
    const spec = world("approval:spec", { spec_pr: 3 }).m;
    expect(approveRequested(spec, { spec: approved }, ME)).toBe(3);
    const plan = world("approval:plan", { spec_pr: 3, plan_pr: 4 }).m;
    expect(approveRequested(plan, { plan: approved }, ME)).toBe(4);
    expect(approveRequested(plan, { spec: approved }, ME)).toBeNull();
  });

  test("events: retry command", () => {
    const { m, cx, db } = world("approval:plan", {
      spec_pr: 3,
      plan_pr: 4,
      feedback_seen: "2026-10-15T10:00:00Z",
    });
    const o = prEvents(
      m,
      { plan: pr({ comments: [said(ME, "2026-10-15T11:00:00Z", "  /retry\n")] }) },
      ME,
      BOT,
    )!;
    expect(o).toEqual({ event: "retry_fresh", set: { feedback_seen: "2026-10-15T11:00:00Z" } });
    const next = apply(cx, m, o);
    expect([next.stage, next.attempt, next.spec_pr]).toEqual(["pick", 2, null]);
    expect(getMission(db, m.id)!.stage).toBe("stopped");
    // Not alone in the comment: feedback; someone else's or an old one: nothing.
    expect(
      prEvents(m, { plan: pr({ comments: [said(ME, "2026-10-15T11:00:00Z", "/retry please")] }) }, ME, BOT)
        ?.event,
    ).toBe("feedback");
    expect(
      prEvents(m, { plan: pr({ comments: [said("x", "2026-10-15T11:00:00Z", "/retry")] }) }, ME, BOT),
    ).toBeNull();
    expect(
      prEvents(m, { plan: pr({ comments: [said(ME, "2026-10-15T09:00:00Z", "/retry")] }) }, ME, BOT),
    ).toBeNull();
  });

  test("events: only the owner's comments count", () => {
    const { m } = world("approval:merge", { pr: 7, head: "h1", feedback_seen: "2026-10-15T10:00:00Z" });
    const code = pr({
      comments: [
        said(ME, "2026-10-15T09:00:00Z", "older than feedback_seen"),
        said(BOT, "2026-10-15T11:00:00Z", "the bot"),
        said("towercab", "2026-10-15T11:00:00Z", "the bot via GraphQL"),
        said("someone", "2026-10-15T11:00:00Z", "a stranger"),
        said("", "2026-10-15T11:00:00Z", "a deleted user"),
        said(ME, "2026-10-15T11:00:00Z", " \n"),
      ],
      reviews: [review("someone", "2026-10-15T11:00:00Z", "CHANGES_REQUESTED", "no")],
    });
    expect(prEvents(m, { code }, ME, BOT)).toBeNull();
    // The owner, in any case, with an offset time: counts.
    code.comments.push(said("OWNER", "2026-10-15T10:30:00+00:00", "mine"));
    expect(prEvents(m, { code }, ME, BOT)).toMatchObject({ event: "feedback", text: "mine" });
    // No `me`: nobody is the owner.
    expect(prEvents(m, { code }, "", BOT)).toBeNull();
    // Unset feedback_seen: all of the owner's count.
    const fresh = world("approval:merge", { pr: 7, head: "h1" }).m;
    expect(prEvents(fresh, { code }, ME, BOT)).toMatchObject({ text: "older than feedback_seen\n\nmine" });
  });

  test("events: release says it is parked", () => {
    const { m } = world("approval:merge", { pr: 7, head: "h1", feedback_seen: "2026-10-15T10:00:00Z" });
    const code = pr({ comments: [said(ME, "2026-10-15T11:00:00Z", "/release", "IC_9")] });
    // Not an event, not feedback: a reply, once.
    expect(prEvents(m, { code }, ME, BOT)).toBeNull();
    const asks = releaseRequested(m, { code }, ME, BOT);
    expect(asks).toEqual([
      { kind: "code", pr: 7, commentId: "IC_9", reply: `<!-- towercab:release:IC_9 -->\n${RELEASE_PARKED}` },
    ]);
    expect(RELEASE_PARKED).toMatch(/parked/);
    code.comments.push(said("towercab", "2026-10-15T11:01:00Z", asks[0]!.reply));
    expect(releaseRequested(m, { code }, ME, BOT)).toEqual([]);
    // Someone else's /release gets nothing.
    expect(
      releaseRequested(
        m,
        { code: pr({ comments: [said("x", "2026-10-15T11:00:00Z", "/release")] }) },
        ME,
        BOT,
      ),
    ).toEqual([]);
  });
});
