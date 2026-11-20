// The `Forge` methods that moved the teammate-review, branch, comment and issue-event reads behind the
// interface (PIP-201): `GitHubForge` words them as the same `gh` calls as before. The `gh` lines are faked
// here, the one place for them besides `forge.test.ts`.

import { expect, test } from "vitest";
import { GitHubForge } from "../../src/github/forge.ts";
import { FakeTools, failResult, okResult } from "../helpers/tools.ts";
import { BOT, fakeGitHub } from "./fakes.ts";

function world(answer: (args: string[], input?: string) => ReturnType<typeof okResult>) {
  const tools = new FakeTools().on("gh", (args, opts) => answer(args, opts.input));
  return { tools, forge: new GitHubForge(fakeGitHub(tools)), lines: () => tools.lines("gh") };
}

test("forge: prsOnBranch lists the PRs of a branch in any state", async () => {
  const w = world(() =>
    okResult(
      JSON.stringify([
        { number: 3, state: "MERGED", author: { login: "app/towercab" } },
        { number: 4, state: "OPEN" },
      ]),
    ),
  );
  expect(await w.forge.prsOnBranch("me/web", "towercab/x")).toEqual([
    { number: 3, state: "MERGED", author: "app/towercab" },
    { number: 4, state: "OPEN", author: "" },
  ]);
  expect(w.lines()).toEqual(["pr list -R me/web --head towercab/x --state all --json number,state,author"]);
});

test("forge: deleteBranch refuses a branch that is not Towercab's and forgives one that is gone", async () => {
  const w = world(() => failResult("gh: Reference does not exist (HTTP 422)"));
  await expect(w.forge.deleteBranch("me/web", "main", null)).rejects.toThrow("not a Towercab branch");
  await expect(w.forge.deleteBranch("me/web", "towercab/x", null)).resolves.toBeUndefined();
  expect(w.lines()).toEqual(["api -X DELETE repos/me/web/git/refs/heads/towercab/x"]);
});

test("forge: openPrTitles and labelEvents read the list and the label events", async () => {
  const w = world((args) =>
    args[0] === "pr"
      ? okResult(JSON.stringify([{ headRefName: "issue/a", title: "docs(intents): add 1 x" }]))
      : okResult(
          '{"label":"towercab:queued","actor":"owner"}\n{"label":"other","actor":"x"}\n{"label":"towercab:queued","actor":"bob"}\n',
        ),
  );
  expect(await w.forge.openPrTitles("me/intents", 50)).toEqual([
    { branch: "issue/a", title: "docs(intents): add 1 x" },
  ]);
  expect(await w.forge.labelEvents("me/web", 7, "towercab:queued")).toEqual([
    { label: "towercab:queued", actor: "owner" },
    { label: "towercab:queued", actor: "bob" },
  ]);
  expect(w.lines()[0]).toBe("pr list -R me/intents --state open --limit 50 --json headRefName,title");
  expect(w.lines()[1]).toContain("api repos/me/web/issues/7/events --paginate");
});

test("forge: upsertPrComment edits the bot's marked comment, else posts", async () => {
  const marker = "<!-- towercab:review:1 -->";
  let listed = "[]";
  const w = world((args) => (args[0] === "api" && args[1] === "--paginate" ? okResult(listed) : okResult()));
  expect(await w.forge.upsertPrComment("me/web", 7, marker, `${marker}\nfirst`)).toEqual({ edited: false });
  listed = JSON.stringify([{ id: 9, user: { login: BOT }, body: `${marker}\nold` }]);
  expect(await w.forge.upsertPrComment("me/web", 7, marker, `${marker}\nnew`)).toEqual({ edited: true });
  expect(w.lines().filter((l) => l.startsWith("pr comment") || l.includes("PATCH"))).toEqual([
    "pr comment 7 -R me/web --body-file -",
    "api -X PATCH repos/me/web/issues/comments/9 --input -",
  ]);
});

test("forge: assignOwner and requestReviewers are one call each, and a refusal is no error", async () => {
  const w = world((args) => (args.includes("reviewers[]=bob") ? failResult("HTTP 422") : okResult("{}")));
  expect(await w.forge.assignOwner("me/web", 7)).toBe(true);
  expect(await w.forge.requestReviewers("me/web", 7, ["alice", "bob"])).toEqual({ failed: ["bob"] });
  expect(w.lines()).toEqual([
    "pr edit 7 -R me/web --add-assignee owner",
    "api -X POST repos/me/web/pulls/7/requested_reviewers -f reviewers[]=alice",
    "api -X POST repos/me/web/pulls/7/requested_reviewers -f reviewers[]=bob",
  ]);
});

test("forge: the teammate reads: CODEOWNERS, changed paths, approvals and the required count", async () => {
  const w = world((args) => {
    const path = args.find((a) => a.startsWith("repos/")) ?? "";
    if (path.includes("/contents/")) return okResult("* @carol\n");
    if (path.includes("/files")) return okResult('[{"filename":"a.ts","previous_filename":"b.ts"}]');
    if (path.includes("/reviews"))
      return okResult('[{"id":5,"state":"APPROVED"},{"id":6,"state":"COMMENTED"}]');
    if (path.includes("/protection"))
      return okResult('{"required_pull_request_reviews":{"required_approving_review_count":2}}');
    return failResult("HTTP 404");
  });
  expect(await w.forge.codeowners("me/web", "main")).toBe("* @carol\n");
  expect(await w.forge.changedPaths("me/web", 7)).toEqual(["a.ts", "b.ts"]);
  expect([...(await w.forge.approvedReviewIds("me/web", 7))]).toEqual(["5"]);
  expect(await w.forge.requiredApprovals("me/web", "main")).toBe(2);
});

test("forge: readPr and readPrExtra read the PR as the loop needs it", async () => {
  const w = world((args) => {
    if (args[0] === "pr")
      return okResult(
        args.includes("author,reviewDecision,baseRefName")
          ? '{"author":{"login":"alice"},"reviewDecision":"REVIEW_REQUIRED","baseRefName":"main"}'
          : '{"state":"OPEN","headRefOid":"h1","mergeable":"MERGEABLE","body":"b","isDraft":false,"reviews":[],"comments":[]}',
      );
    return okResult("[]");
  });
  expect((await w.forge.readPr("me/web", 7)).head).toBe("h1");
  expect(await w.forge.readPrExtra("me/web", 7)).toEqual({
    author: "alice",
    reviewDecision: "REVIEW_REQUIRED",
    base: "main",
  });
});
