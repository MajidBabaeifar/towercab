import { describe, expect, test } from "vitest";
import { upsertStageComment } from "../../src/github/comments.ts";
import { approve, closePr, ownerLogin, reply } from "../../src/github/owner.ts";
import { jsonStream, parsePr, readPr } from "../../src/github/prs.ts";
import type { RunOpts } from "../../src/tools.ts";
import { FakeTools, okResult } from "../helpers/tools.ts";
import { authStatus, BOT, fakeGitHub } from "./fakes.ts";
import { refuse } from "./gh246.ts";

const VIEW = JSON.stringify({
  state: "OPEN",
  mergedAt: null,
  mergeCommit: null,
  headRefOid: "h1",
  mergeable: "MERGEABLE",
  isDraft: false,
  body: "The body",
  comments: [
    {
      id: "IC_1",
      author: { login: "owner" },
      createdAt: "2026-10-15T11:00:00Z",
      body: "a",
    },
  ],
  reviews: [
    {
      id: "PRR_1",
      author: { login: "owner" },
      state: "CHANGES_REQUESTED",
      submittedAt: "2026-10-15T11:05:00Z",
      body: "b",
      commit: { oid: "h1" },
    },
  ],
});

/** Review comments as `gh api --paginate` prints them on gh 2.46: pages back to back. */
const PAGES = `${JSON.stringify([
  {
    id: 501,
    user: { login: "owner" },
    created_at: "2026-10-15T11:10:00Z",
    body: "c",
    path: "src/a.ts",
    line: 4,
  },
])}${JSON.stringify([{ id: 502, user: { login: "x" }, created_at: "2026-10-15T11:20:00Z", body: 'd [x] "q"' }])}\n[]\n`;

/** A gh 2.46 that refuses what it lacks, then answers by command. */
function gh246(answer: (args: string[], opts: RunOpts) => string): FakeTools {
  return new FakeTools().on("gh", (args, opts) => refuse(args) ?? okResult(answer(args, opts)));
}

describe("gh", () => {
  test("github: PR read parses gh 2.46 output", async () => {
    const tools = gh246((args) => (args[0] === "pr" ? VIEW : PAGES));
    const pr = await readPr(fakeGitHub(tools), "me/web", 7);
    expect(tools.lines("gh")).toEqual([
      "pr view 7 -R me/web --json state,mergedAt,mergeCommit,headRefOid,mergeable,isDraft,reviews,comments,body",
      "api --paginate repos/me/web/pulls/7/comments?per_page=100",
    ]);
    expect(tools.calls.every((c) => c.opts.env?.GH_TOKEN === "app")).toBe(true);
    expect(pr).toEqual({
      state: "OPEN",
      mergedAt: null,
      mergeCommit: null,
      head: "h1",
      mergeable: "MERGEABLE",
      body: "The body",
      isDraft: false,
      reviews: [
        { author: "owner", state: "CHANGES_REQUESTED", body: "b", at: "2026-10-15T11:05:00Z", commit: "h1" },
      ],
      comments: [
        { author: "owner", body: "a", at: "2026-10-15T11:00:00Z", id: "IC_1" },
        { author: "owner", body: "c", at: "2026-10-15T11:10:00Z", id: "501", path: "src/a.ts", line: 4 },
        { author: "x", body: 'd [x] "q"', at: "2026-10-15T11:20:00Z", id: "502" },
      ],
    });

    // Merged: mergedAt and the merge commit; no review comments at all is fine.
    const merged = parsePr(
      '{"state":"MERGED","mergedAt":"2026-10-15T12:00:00Z","mergeCommit":{"oid":"m1"},"headRefOid":"h1","mergeable":"UNKNOWN"}',
      "",
    );
    expect([merged.state, merged.mergeCommit, merged.comments]).toEqual(["MERGED", "m1", []]);
    expect(parsePr('{"state":"CLOSED"}', "[]").state).toBe("CLOSED");

    // Broken output is an error that says which call.
    expect(() => parsePr("{", "")).toThrow(/^gh pr view: /);
    expect(() => parsePr(VIEW, "[{]")).toThrow(/^gh api comments: /);
    expect(() => parsePr(VIEW, '{"message":"x"}')).toThrow("gh api comments: not a list");
    expect(() => jsonStream("[1][2", "x")).toThrow("x: cut off");
    expect(jsonStream('[1] [2]\n["]["]')).toEqual([[1], [2], ["]["]]);

    // A refused read fails with gh's reason.
    const failing = new FakeTools().on("gh", () => ({
      code: 1,
      stdout: "",
      stderr: "GraphQL: Could not resolve to a PullRequest with the number of 7.",
      timedOut: false,
    }));
    await expect(readPr(fakeGitHub(failing), "me/web", 7)).rejects.toThrow(
      "gh pr view: GraphQL: Could not resolve to a PullRequest with the number of 7.",
    );
  });

  test("github: only gh 2.46 flags", async () => {
    // gh 2.46 lacks these: each fails as gh's own error.
    const cases: [string[], string][] = [
      [["api", "--paginate", "--slurp", "repos/me/web/pulls/7/comments"], "unknown flag: --slurp"],
      [["pr", "checks", "7", "--json", "state"], "unknown flag: --json"],
      [["pr", "update-branch", "7", "-R", "me/web"], 'unknown command "update-branch" for "gh pr"'],
      [["run", "view", "9", "--json", "attempt"], 'Unknown JSON field: "attempt"'],
      [["pr", "view", "7", "--json", "state,fullDatabaseId"], 'Unknown JSON field: "fullDatabaseId"'],
    ];
    for (const [args, err] of cases) expect(refuse(args)?.stderr.startsWith(err), args.join(" ")).toBe(true);

    // Every gh call this track makes passes gh 2.46.
    let comments = "[]";
    const tools = gh246((args) => {
      if (args[0] === "pr" && args[1] === "view") return VIEW;
      if (args[0] === "api" && args.includes("PATCH")) return "{}";
      if (args[0] === "api" && args[2]?.includes("/issues/")) return comments;
      if (args[0] === "api") return PAGES;
      if (args[0] === "auth") return authStatus("owner");
      return "";
    });
    const gh = fakeGitHub(tools);
    await readPr(gh, "me/web", 7);
    await upsertStageComment(gh, "me/web", 7, "Review", 1, "ok");
    comments = JSON.stringify([{ id: 9, user: { login: BOT }, body: "<!-- towercab:review:1 -->\nold" }]);
    await upsertStageComment(gh, "me/web", 7, "Review", 1, "ok");
    await ownerLogin(gh);
    await approve(gh, "me/web", 7);
    await reply(gh, "me/web", 7, "thanks");
    await closePr(gh, "me/web", 7);
    const refused = tools.calls.filter((c) => refuse(c.args) !== null);
    expect(refused).toEqual([]);
    expect(tools.calls.length).toBeGreaterThanOrEqual(12);
  });
});
