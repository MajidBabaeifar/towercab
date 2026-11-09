// Where the reply goes on GitHub (PIP-204) and that it never counts as feedback (PIP-206): `GitHubForge`
// words the calls, a bot's reply under the owner's comment raises no event.

import { expect, test } from "vitest";
import { feedbackTargets, prEvents, type ReplyTarget } from "../../src/github/events.ts";
import { parsePr } from "../../src/github/prs.ts";
import { postReply } from "../../src/pipeline/reply.ts";
import { FakeTools, okResult } from "../helpers/tools.ts";
import { BOT, fakeGitHub } from "./fakes.ts";

const LINK = "https://github.com/me/web/pull/7#issuecomment-100";
const BY = { agent: "designer", intent: "261102-0019" };

const target = (o: Partial<ReplyTarget> = {}): ReplyTarget => ({
  kind: "spec",
  id: "c1",
  thread: "",
  url: "",
  excerpt: "Please add a case.",
  ...o,
});

/** `gh` as GitHub answers: empty comment lists, a link for a new comment, `{}` for an edit or a reply. */
function world(reviewComments = "[]") {
  const tools = new FakeTools().on("gh", (args) => {
    if (args[0] === "api" && args[1] === "--paginate")
      return okResult(args[2]!.includes("/pulls/") ? reviewComments : "[]");
    if (args[0] === "api") return okResult("{}");
    return okResult(`${LINK}\n`);
  });
  return { tools, forge: fakeGitHub(tools) };
}

test("github: the reply is one general comment with header and marker", async () => {
  const w = world();
  const out = await postReply(w.forge, {
    github: "me/web",
    n: 7,
    round: 2,
    by: BY,
    targets: [target(), target({ id: "c2", excerpt: "Name the text." })],
    text: "Added both cases.",
  });
  expect(out).toEqual({ url: LINK, failed: [] });
  const posted = w.tools.calls.filter((c) => c.args[0] === "pr");
  expect(posted).toHaveLength(1);
  const lines = posted[0]!.opts.input!.split("\n");
  expect(lines[0]).toBe("<!-- towercab:reply:2 -->");
  expect(lines[1]).toBe("**Reply** · designer · 261102-0019 · round 2");
  expect(posted[0]!.opts.input).toContain("> Please add a case.");
  expect(posted[0]!.opts.input).toContain("> Name the text.");
  expect(posted[0]!.opts.input).toContain("Added both cases.");
  // The same round again edits the comment instead of adding another.
  const edited = new FakeTools().on("gh", (args) => {
    if (args[0] === "api" && args[1] === "--paginate")
      return okResult(JSON.stringify([{ id: 100, user: { login: BOT }, body: lines.join("\n") }]));
    return okResult(JSON.stringify({ html_url: LINK }));
  });
  const second = await postReply(fakeGitHub(edited), {
    github: "me/web",
    n: 7,
    round: 2,
    by: BY,
    targets: [target()],
    text: "Changed.",
  });
  expect(second.url).toBe(LINK);
  expect(edited.lines("gh").some((l) => l.includes("PATCH repos/me/web/issues/comments/100"))).toBe(true);
  expect(edited.lines("gh").some((l) => l.startsWith("pr comment"))).toBe(false);
});

test("github: a line comment gets an answered-in pointer in its thread", async () => {
  const w = world();
  const out = await postReply(w.forge, {
    github: "me/web",
    n: 7,
    round: 2,
    by: BY,
    targets: [target({ id: "55", thread: "55", excerpt: "specs/web.md:3: Say more." })],
    text: "Said more.",
  });
  expect(out.failed).toEqual([]);
  const lines = w.tools.lines("gh");
  const general = lines.findIndex((l) => l.startsWith("pr comment"));
  const pointer = lines.indexOf("api -X POST repos/me/web/pulls/7/comments/55/replies --input -");
  // The pointer links to the general comment, so it goes up after it.
  expect(general).toBeGreaterThanOrEqual(0);
  expect(pointer).toBeGreaterThan(general);
  const body = JSON.parse(w.tools.calls[pointer]!.opts.input!).body as string;
  expect(body.split("\n")[0]).toBe("<!-- towercab:reply-pointer:2:55 -->");
  expect(body).toContain("**Reply** · designer · 261102-0019 · round 2");
  expect(body).toContain(`Answered in ${LINK}`);

  // The same round again edits the bot's pointer.
  const edited = world(
    JSON.stringify([{ id: 900, user: { login: BOT }, body: "<!-- towercab:reply-pointer:2:55 -->\nold" }]),
  );
  await postReply(edited.forge, {
    github: "me/web",
    n: 7,
    round: 2,
    by: BY,
    targets: [target({ id: "55", thread: "55" })],
    text: "Again.",
  });
  expect(edited.tools.lines("gh")).toContain("api -X PATCH repos/me/web/pulls/comments/900 --input -");
  expect(edited.tools.lines("gh").some((l) => l.includes("/replies"))).toBe(false);
});

test("github: a plain comment gets no pointer and is quoted", async () => {
  const w = world();
  const url = "https://github.com/me/web/pull/7#issuecomment-5";
  await postReply(w.forge, {
    github: "me/web",
    n: 7,
    round: 1,
    by: BY,
    targets: [target({ id: "IC_5", url, excerpt: "Is this the right name?" })],
    text: "Yes.",
  });
  expect(w.tools.lines("gh").some((l) => l.includes("/replies"))).toBe(false);
  const posted = w.tools.calls.find((c) => c.args[0] === "pr")!.opts.input!;
  expect(posted).toContain(`> Is this the right name? ([comment](${url}))`);
});

test("events: a reply under the owner's comment raises no event", () => {
  // The owner's comment was taken already; Towercab's reply and its pointer came after it.
  const view = JSON.stringify({
    state: "OPEN",
    headRefOid: "h1",
    mergeable: "MERGEABLE",
    comments: [
      { id: "IC_1", author: { login: "owner" }, createdAt: "2026-10-15T11:00:00Z", body: "Add a case." },
      {
        id: "IC_2",
        author: { login: "towercab" },
        createdAt: "2026-10-15T13:00:00Z",
        body: "<!-- towercab:reply:1 -->\n**Reply** · designer · 261001-0900 · round 1\n\nAdded it.",
      },
    ],
    reviews: [],
  });
  const threads = JSON.stringify([
    {
      id: 5,
      user: { login: BOT },
      created_at: "2026-10-15T13:00:01Z",
      body: "<!-- towercab:reply-pointer:1:4 -->\n**Reply**\n\nAnswered in x",
      path: "specs/web.md",
      line: 3,
      pull_request_review_id: 9,
    },
  ]);
  const row = {
    stage: "approval:merge" as const,
    pr: 7,
    head: "h1",
    feedback_seen: "2026-10-15T12:00:00Z",
    data: "{}",
    spec_pr: null,
    plan_pr: null,
  };
  const prs = { code: parsePr(view, threads) };
  // biome-ignore lint/suspicious/noExplicitAny: a partial mission row is all `prEvents` reads
  expect(prEvents(row as any, prs, "owner", BOT)).toBeNull();
  // biome-ignore lint/suspicious/noExplicitAny: as above
  expect(feedbackTargets(row as any, prs, "owner", BOT)).toEqual([]);
});

test("github: feedbackTargets names the owner's comments, with the thread of a line comment", () => {
  const view = JSON.stringify({
    state: "OPEN",
    headRefOid: "h1",
    mergeable: "MERGEABLE",
    comments: [
      {
        id: "IC_1",
        author: { login: "owner" },
        createdAt: "2026-10-15T11:00:00Z",
        body: "Add a case.\nAnd more.",
        url: "https://github.com/me/web/pull/7#issuecomment-1",
      },
    ],
    reviews: [],
  });
  const threads = JSON.stringify([
    {
      id: 5,
      user: { login: "owner" },
      created_at: "2026-10-15T11:30:00Z",
      body: "Say more here.",
      path: "specs/web.md",
      line: 3,
      html_url: "https://github.com/me/web/pull/7#discussion_r5",
    },
  ]);
  const row = { stage: "approval:merge", pr: 7, head: "h1", feedback_seen: null, data: "{}" };
  // biome-ignore lint/suspicious/noExplicitAny: a partial mission row is all `prEvents` reads
  const got = feedbackTargets(row as any, { code: parsePr(view, threads) }, "owner", BOT);
  expect(got).toEqual([
    {
      kind: "code",
      id: "IC_1",
      thread: "",
      url: "https://github.com/me/web/pull/7#issuecomment-1",
      excerpt: "Add a case.",
    },
    {
      kind: "code",
      id: "5",
      thread: "5",
      url: "https://github.com/me/web/pull/7#discussion_r5",
      excerpt: "specs/web.md:3: Say more here.",
    },
  ]);
});
