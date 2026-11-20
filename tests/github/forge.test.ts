// `GitHubForge` over a fake `gh`: each method's arguments and what it makes of the reply.

import { expect, test } from "vitest";
import { ForgeBadReply, ForgeDenied, MERGE_METHOD, must } from "../../src/forge.ts";
import { GitHubForge } from "../../src/github/forge.ts";
import { FakeTools, failResult, okResult } from "../helpers/tools.ts";
import { fakeGitHub } from "./fakes.ts";

function world(answer: (args: string[], input?: string) => ReturnType<typeof okResult>) {
  const tools = new FakeTools().on("gh", (args, opts) => answer(args, opts.input));
  return { tools, forge: new GitHubForge(fakeGitHub(tools)), lines: () => tools.lines("gh") };
}

test("forge: mergePr builds one squash merge, with the head when given", async () => {
  const w = world(() => okResult());
  expect(await w.forge.mergePr("me/web", 7, { method: MERGE_METHOD })).toEqual({ ok: true, reason: "" });
  await w.forge.mergePr("me/web", 8, { method: MERGE_METHOD, head: "abc" });
  expect(w.lines()).toEqual([
    "pr merge 7 --squash -R me/web",
    "pr merge 8 --squash --match-head-commit abc -R me/web",
  ]);
});

test("forge: a refused merge is a result, and must() reads it as the old error", async () => {
  const w = world(() => failResult("Pull request is not mergeable\nmore"));
  const r = await w.forge.mergePr("me/web", 7, { method: MERGE_METHOD });
  expect(r).toEqual({ ok: false, reason: "Pull request is not mergeable\nmore" });
  expect(() => must(r, "gh pr merge")).toThrow("gh pr merge: Pull request is not mergeable");
});

test("forge: openPr returns the number in the URL, or null", async () => {
  const w = world((args) =>
    args.includes("a") ? okResult("https://github.com/me/web/pull/12\n") : okResult("created\n"),
  );
  const o = { base: "main", title: "t", body: "b" };
  expect(await w.forge.openPr("me/web", { ...o, head: "a" })).toBe(12);
  expect(await w.forge.openPr("me/web", { ...o, head: "x" })).toBeNull();
  expect(w.lines()[0]).toBe("pr create -R me/web --base main --head a --title t --body-file -");
});

test("forge: openPrOn and openPrBranches read the open list", async () => {
  const w = world((args) =>
    okResult(args.includes("--head") ? '[{"number":4}]' : '[{"number":4,"headRefName":"towercab/x"}]'),
  );
  expect(await w.forge.openPrOn("me/web", "towercab/x")).toBe(4);
  expect(await w.forge.openPrBranches("me/web")).toEqual([{ number: 4, branch: "towercab/x" }]);
  expect(w.lines()).toEqual([
    "pr list -R me/web --head towercab/x --state open --json number",
    "pr list -R me/web --state open --json number,headRefName",
  ]);
});

test("forge: readChecks parses the rollup and failedLog reads a run", async () => {
  const w = world((args) =>
    args[0] === "run"
      ? okResult("boom\n")
      : okResult(
          JSON.stringify({
            headRefOid: "h1",
            mergeable: "MERGEABLE",
            statusCheckRollup: [
              {
                name: "test",
                status: "COMPLETED",
                conclusion: "FAILURE",
                detailsUrl: "https://github.com/me/web/actions/runs/55/job/1",
              },
            ],
          }),
        ),
  );
  const r = await w.forge.readChecks("me/web", 3);
  expect(r.head).toBe("h1");
  expect(r.checks).toMatchObject([{ name: "test", kind: "run", conclusion: "FAILURE", run: 55 }]);
  expect(await w.forge.failedLog("me/web", 55)).toBe("boom\n");
  await w.forge.rerunFailed("me/web", 55);
  await w.forge.cancelRun("me/web", 55);
  expect(w.lines().slice(1)).toEqual([
    "run view 55 -R me/web --log-failed",
    "run rerun 55 -R me/web --failed",
    "run cancel 55 -R me/web",
  ]);
});

test("forge: mergeStatus reads the state, head and merge commit", async () => {
  const w = world(() =>
    okResult('{"headRefOid":"h","mergeStateStatus":"BEHIND","state":"MERGED","mergeCommit":{"oid":"m"}}'),
  );
  expect(await w.forge.mergeStatus("me/web", 3)).toEqual({
    state: "MERGED",
    head: "h",
    mergeState: "BEHIND",
    mergeCommit: "m",
  });
});

test("forge: prBrief tells a refusal from a reply that isn't JSON", async () => {
  expect(
    await world(() => okResult('{"state":"OPEN","isDraft":true,"headRefOid":"h"}')).forge.prBrief("a/b", 1),
  ).toEqual({
    state: "OPEN",
    draft: true,
    head: "h",
    merged: false,
  });
  await expect(world(() => failResult("not found")).forge.prBrief("a/b", 1)).rejects.toThrow("not found");
  await expect(world(() => okResult("<html>")).forge.prBrief("a/b", 1)).rejects.toBeInstanceOf(ForgeBadReply);
});

test("forge: comments, ready, close and the PR text go through gh", async () => {
  const w = world(() => okResult());
  await w.forge.commentOnPr("me/web", 5, "hi");
  await w.forge.commentOnPr("me/web", 5, "/pass", { inline: true });
  await w.forge.markReady("me/web", 5);
  await w.forge.closePr("me/web", 5, "why");
  await w.forge.updatePrBody("me/web", 5, "body");
  await w.forge.updateBranch("me/web", 5, "h");
  expect(w.lines()).toEqual([
    "pr comment 5 -R me/web --body-file -",
    "pr comment 5 -R me/web --body /pass",
    "pr ready 5 -R me/web",
    "pr close 5 -R me/web --comment why",
    "api -X PATCH repos/me/web/pulls/5 -F body=@-",
    "api -X PUT repos/me/web/pulls/5/update-branch -f expected_head_sha=h",
  ]);
});

test("forge: deployments are read, and a 403 on create is ForgeDenied", async () => {
  const w = world((args) =>
    args.includes("POST")
      ? failResult("gh: Resource not accessible by integration (HTTP 403)")
      : args.some((a) => a.includes("/statuses"))
        ? okResult('[{"state":"success","description":null}]')
        : okResult('[{"id":1,"sha":"s","task":"deploy","created_at":"t","payload":null}]'),
  );
  expect(await w.forge.listDeployments("me/web", "production prod", "s")).toEqual([
    { id: 1, sha: "s", task: "deploy", createdAt: "t", payload: null },
  ]);
  expect(await w.forge.deploymentStatus("me/web", 1)).toEqual({ state: "success", description: "" });
  await expect(w.forge.createDeployment("me/web", { ref: "s" })).rejects.toBeInstanceOf(ForgeDenied);
  expect(w.lines()[0]).toBe("api repos/me/web/deployments?environment=production%20prod&per_page=30&sha=s");
});

test("forge: repoInfo gives the host's spelling and default branch", async () => {
  const w = world(() => okResult("Me/Web trunk\n"));
  expect(await w.forge.repoInfo("me/web")).toEqual({ name: "Me/Web", defaultBranch: "trunk" });
  await expect(world(() => failResult("gh: Not Found (HTTP 404)")).forge.repoInfo("me/x")).rejects.toThrow(
    "gh: Not Found (HTTP 404)",
  );
});

test("forge: asOwner acts with the owner's login, not the bot's", async () => {
  const tools = new FakeTools().on("gh", () => okResult());
  const forge = new GitHubForge(fakeGitHub(tools));
  await forge.asOwner().markReady("me/web", 1);
  await forge.markReady("me/web", 1);
  expect(tools.calls.map((c) => c.opts.env)).toEqual([{}, { GH_TOKEN: "app" }]);
});
